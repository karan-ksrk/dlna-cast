# Captures what the default playback device is playing (WASAPI loopback) and writes raw PCM to stdout.
# The first stderr line announces the format: "FORMAT <ffmpeg sample format> <rate> <channels>".
# Loopback delivers nothing while the system is silent, so silence is filled in to keep the stream continuous.
$ErrorActionPreference = 'Stop'

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace DlnaCast {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject {}

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
  }

  [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint frames);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
  }

  [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
  }

  public static class Loopback {
    const int ERender = 0, EMultimedia = 1, ClsctxAll = 23;
    const int SharedMode = 0, LoopbackFlag = 0x00020000, SilentFlag = 0x2;
    static readonly Guid FloatSubtype = new Guid("00000003-0000-0010-8000-00aa00389b71");

    static void Check(int hr, string what) {
      if (hr < 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8"));
    }

    static string SampleFormat(IntPtr format, int bits) {
      int tag = (ushort)Marshal.ReadInt16(format, 0);
      bool isFloat = tag == 3;
      if (tag == 0xFFFE) {
        byte[] subtype = new byte[16];
        Marshal.Copy(IntPtr.Add(format, 24), subtype, 0, 16);
        isFloat = new Guid(subtype) == FloatSubtype;
      }
      if (isFloat && bits == 32) return "f32le";
      if (bits == 16) return "s16le";
      if (bits == 24) return "s24le";
      if (bits == 32) return "s32le";
      throw new Exception("Unsupported mix format: tag " + tag + ", " + bits + " bits");
    }

    public static void Run() {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
      IMMDevice device;
      Check(enumerator.GetDefaultAudioEndpoint(ERender, EMultimedia, out device), "GetDefaultAudioEndpoint");

      Guid audioClientId = typeof(IAudioClient).GUID;
      object instance;
      Check(device.Activate(ref audioClientId, ClsctxAll, IntPtr.Zero, out instance), "Activate");
      var client = (IAudioClient)instance;

      IntPtr format;
      Check(client.GetMixFormat(out format), "GetMixFormat");
      int channels = (ushort)Marshal.ReadInt16(format, 2);
      int rate = Marshal.ReadInt32(format, 4);
      int blockAlign = (ushort)Marshal.ReadInt16(format, 12);
      int bits = (ushort)Marshal.ReadInt16(format, 14);
      string sampleFormat = SampleFormat(format, bits);

      Check(client.Initialize(SharedMode, LoopbackFlag, 10000000, 0, format, IntPtr.Zero), "Initialize");
      Guid captureId = typeof(IAudioCaptureClient).GUID;
      object service;
      Check(client.GetService(ref captureId, out service), "GetService");
      var capture = (IAudioCaptureClient)service;

      Console.Error.WriteLine("FORMAT " + sampleFormat + " " + rate + " " + channels);
      Console.Error.Flush();

      Stream output = Console.OpenStandardOutput();
      byte[] buffer = new byte[rate * blockAlign];
      long framesWritten = 0;
      long jitterFrames = rate / 20;   // 50 ms
      long aheadLimit = rate / 5;      // 200 ms
      var clock = Stopwatch.StartNew();
      Check(client.Start(), "Start");
      try {
        while (true) {
          Thread.Sleep(10);
          uint packet;
          Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize");
          while (packet > 0) {
            IntPtr data; uint frames, flags; ulong devicePosition, qpcPosition;
            Check(capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition), "GetBuffer");
            int bytes = (int)frames * blockAlign;
            if (buffer.Length < bytes) buffer = new byte[bytes];
            if ((flags & SilentFlag) != 0) Array.Clear(buffer, 0, bytes); else Marshal.Copy(data, buffer, 0, bytes);
            capture.ReleaseBuffer(frames);
            long expected = clock.ElapsedMilliseconds * rate / 1000;
            // Drop audio that arrives after we already filled its time with silence, so latency can't build up.
            if (framesWritten - expected < aheadLimit) {
              output.Write(buffer, 0, bytes);
              framesWritten += frames;
            }
            Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize");
          }
          long behind = clock.ElapsedMilliseconds * rate / 1000 - framesWritten - jitterFrames;
          while (behind > 0) {
            int frames = (int)Math.Min(behind, buffer.Length / blockAlign);
            Array.Clear(buffer, 0, frames * blockAlign);
            output.Write(buffer, 0, frames * blockAlign);
            framesWritten += frames;
            behind -= frames;
          }
          output.Flush();
        }
      } catch (IOException) {
        // The reader (ffmpeg) went away: normal shutdown.
      } finally {
        client.Stop();
      }
    }
  }
}
'@

[DlnaCast.Loopback]::Run()
