using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Windows.Forms;

namespace Treeps1Saver
{
    // Windows runs a screensaver with:
    //   /s          show it full screen
    //   /c[:hwnd]   open the settings dialog (also: no arguments)
    //   /p <hwnd>   draw into the little preview monitor (not supported: we just exit)
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var mode = args.Length == 0 ? 'c' : char.ToLowerInvariant(args[0].TrimStart('/', '-').FirstOrDefault());
            var settings = Settings.Load();
            switch (mode)
            {
                case 's': RunSaver(settings); break;
                case 'p': break;
                default: Application.Run(new SettingsForm(settings)); break;
            }
        }

        static void RunSaver(Settings s)
        {
            var primary = Screen.PrimaryScreen;
            double primaryAspect = (double)primary.Bounds.Width / primary.Bounds.Height;
            int primaryCentre = primary.Bounds.X + primary.Bounds.Width / 2;

            // Screens left to right; `pan` is each one's offset from the primary in screen widths.
            var screens = Screen.AllScreens.OrderBy(sc => sc.Bounds.X).ToList();
            var forms = new List<SaverForm>();
            for (int i = 0; i < screens.Count; i++)
            {
                var sc = screens[i];
                int pan = (int)Math.Round((double)(sc.Bounds.X + sc.Bounds.Width / 2 - primaryCentre) / primary.Bounds.Width);
                string url = s.BuildUrl(i, pan, primaryAspect, audio: sc.Primary);
                forms.Add(new SaverForm(sc, url, s.ResolveWebFolder()));
            }
            Cursor.Hide();
            foreach (var f in forms) f.Show();
            Application.Run(new ApplicationContext(forms.First(f => f.Screen.Primary)));
        }

        public static void Exit()
        {
            Cursor.Show();
            Application.Exit();
        }

        public static void Preview()
        {
            Process.Start(new ProcessStartInfo(Application.ExecutablePath, "/s") { UseShellExecute = false });
        }
    }
}
