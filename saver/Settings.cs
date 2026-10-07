using System;
using System.Globalization;
using System.IO;
using System.Text.Json;

namespace Treeps1Saver
{
    // Saved to %APPDATA%\treeps1\saver.json and passed to the page as query parameters.
    public class Settings
    {
        public int MasterVolume { get; set; } = 60;
        public int WindVolume { get; set; } = 50;
        public int BirdVolume { get; set; } = 60;
        public int SceneMinutes { get; set; } = 15;
        public int BirdRestMinutes { get; set; } = 10;
        public int BirdActiveMinutes { get; set; } = 3;
        public string Layout { get; set; } = "panorama"; // panorama | same | separate
        public int PixelHeight { get; set; } = 240;
        public int MaxFps { get; set; } = 30;
        public string WebFolder { get; set; } = "";

        static string FilePath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "treeps1", "saver.json");

        public static Settings Load()
        {
            try
            {
                if (File.Exists(FilePath)) return JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath)) ?? new Settings();
            }
            catch { /* fall back to defaults */ }
            return new Settings();
        }

        public void Save()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }

        // The web files: the configured folder, else "web" next to the .scr.
        public string ResolveWebFolder()
        {
            if (!string.IsNullOrWhiteSpace(WebFolder) && File.Exists(Path.Combine(WebFolder, "index.html"))) return WebFolder;
            return Path.Combine(AppContext.BaseDirectory, "web");
        }

        public string BuildUrl(int screen, int pan, double primaryAspect, bool audio)
        {
            var c = CultureInfo.InvariantCulture;
            return "https://treeps1.local/index.html?saver" +
                $"&screen={screen}&pan={pan}&pa={primaryAspect.ToString("F4", c)}&layout={Layout}" +
                $"&audio={(audio ? 1 : 0)}&vol={MasterVolume}&wind={WindVolume}&birds={BirdVolume}" +
                $"&mins={SceneMinutes}&rest={BirdRestMinutes}&active={BirdActiveMinutes}" +
                $"&px={PixelHeight}&fps={MaxFps}";
        }
    }
}
