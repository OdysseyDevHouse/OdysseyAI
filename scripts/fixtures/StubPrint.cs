// A stand-in for odyssey-rawprint.exe, so scripts/test-print-queue.mjs can
// exercise the REAL spawn path — Node on Windows refuses to spawn a .cmd
// without shell:true (CVE-2024-27980), and `shell: true` is exactly what the
// transport must never use. So the stub has to be a genuine executable.
//
// Reports what actually reached it: the argv it was handed and the SHA-256 of
// the job file. Exits 9 when the queue name starts with "FAIL", so the failure
// path is covered by the same binary.
using System;
using System.IO;
using System.Security.Cryptography;

public class StubPrint
{
    public static int Main(string[] args)
    {
        if (args.Length != 2) { Console.Error.WriteLine("usage: stub <printer> <job>"); return 2; }
        byte[] bytes = File.ReadAllBytes(args[1]);
        string hash;
        using (SHA256 sha = SHA256.Create())
            hash = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();

        Console.Out.Write("{\"queue\":" + Quote(args[0]) + ",\"jobFile\":" + Quote(args[1])
            + ",\"sha256\":\"" + hash + "\",\"length\":" + bytes.Length + "}\n");

        if (args[0].StartsWith("FAIL")) { Console.Error.WriteLine("The printer refused the job."); return 9; }
        return 0;
    }

    static string Quote(string s)
    {
        return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }
}
