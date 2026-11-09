using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;

internal static class Program
{
    private const int DefaultPort = 4073;

    private static async Task<int> Main()
    {
        var appDirectory = AppContext.BaseDirectory;
        var nodePath = Path.Combine(appDirectory, "node.exe");
        var serverPath = Path.Combine(appDirectory, "server", "index.js");
        var envPath = Path.Combine(appDirectory, ".env");
        var exampleEnvPath = Path.Combine(appDirectory, ".env.example");

        if (!File.Exists(nodePath) || !File.Exists(serverPath))
        {
            Console.Error.WriteLine("War Room is missing files. Extract the full release ZIP, then try again.");
            return 1;
        }

        if (!File.Exists(envPath) && File.Exists(exampleEnvPath))
            File.Copy(exampleEnvPath, envPath);

        var port = ReadPort(envPath);
        using var server = Process.Start(new ProcessStartInfo
        {
            FileName = nodePath,
            WorkingDirectory = appDirectory,
            UseShellExecute = false,
            Arguments = $"\"{serverPath}\""
        });

        if (server is null)
        {
            Console.Error.WriteLine("War Room could not start its local server.");
            return 1;
        }

        var stopping = false;
        ConsoleCancelEventHandler cancelHandler = (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            stopping = true;
        };
        Console.CancelKeyPress += cancelHandler;

        try
        {
            Console.WriteLine("Starting War Room. Press Ctrl+C to stop it.");
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(1) };
            var ready = false;
            var deadline = DateTime.UtcNow.AddSeconds(30);
            while (!stopping && !server.HasExited && DateTime.UtcNow < deadline)
            {
                try
                {
                    using var response = await client.GetAsync($"http://127.0.0.1:{port}/");
                    if (response.StatusCode == HttpStatusCode.OK)
                    {
                        ready = true;
                        break;
                    }
                }
                catch (HttpRequestException)
                {
                }
                catch (TaskCanceledException)
                {
                }

                await Task.Delay(250);
            }

            if (!ready)
            {
                if (!server.HasExited)
                    server.Kill(entireProcessTree: true);
                if (stopping)
                    return 0;
                Console.Error.WriteLine("War Room did not start. Check the messages above, then try again.");
                return 1;
            }

            var url = $"http://localhost:{port}";
            Console.WriteLine($"War Room running at {url}");
            Console.WriteLine("(Keep this window open while using the app. Close it to stop.)");
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch (Win32Exception exception)
            {
                Console.Error.WriteLine($"Could not open your browser: {exception.Message}");
                Console.WriteLine($"Open {url} in your browser.");
            }
            catch (InvalidOperationException exception)
            {
                Console.Error.WriteLine($"Could not open your browser: {exception.Message}");
                Console.WriteLine($"Open {url} in your browser.");
            }

            while (!stopping && !server.HasExited)
                await Task.Delay(250);

            if (stopping)
            {
                if (!server.HasExited)
                {
                    server.Kill(entireProcessTree: true);
                    await server.WaitForExitAsync();
                }
                return 0;
            }

            return server.ExitCode;
        }
        finally
        {
            Console.CancelKeyPress -= cancelHandler;
            if (!server.HasExited)
                server.Kill(entireProcessTree: true);
        }
    }

    private static int ReadPort(string envPath)
    {
        if (!File.Exists(envPath))
            return DefaultPort;

        foreach (var line in File.ReadLines(envPath))
        {
            var entry = line.Trim();
            if (entry.StartsWith("export ", StringComparison.Ordinal))
                entry = entry[7..].TrimStart();

            var separator = entry.IndexOf('=');
            if (separator < 0 || !entry[..separator].Trim().Equals("PORT", StringComparison.Ordinal))
                continue;

            var value = entry[(separator + 1)..].Trim().Trim('"', '\'');
            if (int.TryParse(value, out var port) && port is > 0 and <= 65535)
                return port;
        }

        return DefaultPort;
    }
}
