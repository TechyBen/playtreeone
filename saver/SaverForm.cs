using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Treeps1Saver
{
    // One borderless, topmost window per monitor, hosting the page in WebView2.
    public class SaverForm : Form
    {
        static Task<CoreWebView2Environment> envTask;

        public Screen Screen { get; }
        readonly string url, webFolder;
        readonly WebView2 web;
        readonly Timer cursorWatch;
        Point? cursorStart;

        public SaverForm(Screen screen, string url, string webFolder)
        {
            Screen = screen;
            this.url = url;
            this.webFolder = webFolder;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = screen.Bounds;
            TopMost = true;
            ShowInTaskbar = false;
            BackColor = Color.Black;
            KeyPreview = true;
            KeyDown += (_, __) => Program.Exit();
            MouseDown += (_, __) => Program.Exit();

            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.Black };
            Controls.Add(web);
            Load += async (_, __) => await InitAsync();

            // The web page reports input too, but watching the cursor here also covers
            // the moment before the page has loaded. A short grace period ignores
            // jitter while the windows appear.
            cursorWatch = new Timer { Interval = 100 };
            var shownAt = DateTime.Now;
            cursorWatch.Tick += (_, __) =>
            {
                if ((DateTime.Now - shownAt).TotalSeconds < 1.5) return;
                cursorStart ??= Cursor.Position;
                var p = Cursor.Position;
                if (Math.Abs(p.X - cursorStart.Value.X) + Math.Abs(p.Y - cursorStart.Value.Y) > 12) Program.Exit();
            };
            cursorWatch.Start();
        }

        async Task InitAsync()
        {
            try
            {
                envTask ??= CoreWebView2Environment.CreateAsync(null,
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "treeps1", "WebView2"),
                    new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required"));
                await web.EnsureCoreWebView2Async(await envTask);
                var cw = web.CoreWebView2;
                cw.Settings.AreDefaultContextMenusEnabled = false;
                cw.Settings.IsStatusBarEnabled = false;
                cw.Settings.IsZoomControlEnabled = false;
                cw.Settings.AreBrowserAcceleratorKeysEnabled = false;
                // Serve the local files over a virtual https host so ES modules load.
                cw.SetVirtualHostNameToFolderMapping("treeps1.local", webFolder, CoreWebView2HostResourceAccessKind.Allow);
                cw.WebMessageReceived += (_, e) => { if (e.TryGetWebMessageAsString() == "exit") Program.Exit(); };
                cw.Navigate(url);
                if (Screen.Primary) web.Focus();
            }
            catch (Exception ex)
            {
                // Show the problem rather than a silent black screen.
                Controls.Remove(web);
                Controls.Add(new Label
                {
                    Text = "treeps1 screensaver could not start:\n" + ex.Message + "\n\nWeb folder: " + webFolder,
                    ForeColor = Color.Gainsboro, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter,
                });
            }
        }
    }
}
