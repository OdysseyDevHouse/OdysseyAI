// odyssey-rawprint.exe — hands RAW bytes to a Windows print queue.
//
//   odyssey-rawprint.exe "<printer name>" "<path to job file>"
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Node cannot submit a RAW spool job on Windows, and every alternative is worse:
// PowerShell's Out-Printer renders through the GDI driver (ESC/POS comes out as
// literal garbage), inline C# via Add-Type compiles on every call and is blocked
// by Constrained Language Mode, and the \localhost\<Share> trick needs the
// printer shared under a name that is not the printer's name.
//
// So: about sixty lines calling the spooler directly. Note what this is NOT — a
// native node module. There is no binding.gyp, no node-gyp and no ABI coupling,
// so nothing here has to be rebuilt when Electron moves from 38 to 40.
//
// Built by scripts/build-rawprint.mjs with the csc.exe that ships with Windows,
// and the resulting exe is COMMITTED — the same way build/icon.ico is, and for
// the same reason: a build that silently regenerates a binary is a build whose
// output nobody reviewed.
//
// ── datatype "RAW" IS THE WHOLE POINT ───────────────────────────────────────
//
// It tells the spooler to pass the bytes to the device untouched rather than
// through the printer driver. Without it the escape codes are rendered as text.
using System;
using System.IO;
using System.Runtime.InteropServices;

public class RawPrint
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DOCINFO
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFO di);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int count, out int written);

    public static int Main(string[] args)
    {
        if (args.Length != 2)
        {
            Console.Error.WriteLine("usage: odyssey-rawprint.exe \"<printer>\" \"<job file>\"");
            return 2;
        }

        string printer = args[0];
        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(args[1]);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("Could not read the print job: " + ex.Message);
            return 3;
        }
        if (bytes.Length == 0)
        {
            Console.Error.WriteLine("There was nothing to print.");
            return 4;
        }

        IntPtr hPrinter;
        if (!OpenPrinter(printer, out hPrinter, IntPtr.Zero))
        {
            // The message names the printer, because "error 1801" sends nobody
            // anywhere and "there is no printer called X" sends them to Settings.
            Console.Error.WriteLine("Could not open the printer \"" + printer + "\" (Windows error "
                + Marshal.GetLastWin32Error() + ").");
            return 5;
        }

        // Unmanaged, and freed in the finally: WritePrinter takes a pointer, and
        // a managed array could be moved by the GC between the pin and the call.
        IntPtr buffer = IntPtr.Zero;
        try
        {
            DOCINFO di = new DOCINFO();
            di.pDocName = "Odyssey print job";
            di.pDataType = "RAW";

            if (!StartDocPrinter(hPrinter, 1, ref di))
            {
                Console.Error.WriteLine("The printer \"" + printer + "\" refused the job (Windows error "
                    + Marshal.GetLastWin32Error() + ").");
                return 6;
            }
            if (!StartPagePrinter(hPrinter))
            {
                EndDocPrinter(hPrinter);
                Console.Error.WriteLine("The printer \"" + printer + "\" refused the page (Windows error "
                    + Marshal.GetLastWin32Error() + ").");
                return 7;
            }

            buffer = Marshal.AllocHGlobal(bytes.Length);
            Marshal.Copy(bytes, 0, buffer, bytes.Length);

            int written;
            bool wrote = WritePrinter(hPrinter, buffer, bytes.Length, out written);

            EndPagePrinter(hPrinter);
            EndDocPrinter(hPrinter);

            if (!wrote || written != bytes.Length)
            {
                Console.Error.WriteLine("Only " + written + " of " + bytes.Length
                    + " bytes reached the printer \"" + printer + "\".");
                return 8;
            }
            return 0;
        }
        finally
        {
            if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
            ClosePrinter(hPrinter);
        }
    }
}
