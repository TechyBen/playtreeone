using System;
using System.Drawing;
using System.Windows.Forms;

namespace Treeps1Saver
{
    // The dialog behind "Settings..." in Windows' Screen Saver Settings.
    public class SettingsForm : Form
    {
        readonly Settings s;
        readonly TableLayoutPanel grid;

        public SettingsForm(Settings settings)
        {
            s = settings;
            Text = "treeps1 screensaver";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Padding = new Padding(12);
            Font = new Font("Segoe UI", 9f);

            grid = new TableLayoutPanel { ColumnCount = 3, AutoSize = true, Dock = DockStyle.Fill };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 260));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            Controls.Add(grid);

            Heading("Sound");
            Slider("Master volume", s.MasterVolume, v => s.MasterVolume = v);
            Slider("Wind", s.WindVolume, v => s.WindVolume = v);
            Slider("Birds", s.BirdVolume, v => s.BirdVolume = v);
            Number("Bird quiet spell (minutes)", s.BirdRestMinutes, 1, 60, v => s.BirdRestMinutes = v);
            Number("Bird active spell (minutes)", s.BirdActiveMinutes, 1, 20, v => s.BirdActiveMinutes = v);

            Heading("Scene");
            Number("Change scene every (minutes)", s.SceneMinutes, 1, 120, v => s.SceneMinutes = v);
            Choice("Multiple monitors", new[] { "panorama", "same", "separate" },
                new[] { "One wide view across monitors", "Same view on each", "A different forest on each" },
                s.Layout, v => s.Layout = v);
            Number("Pixel height", s.PixelHeight, 120, 720, v => s.PixelHeight = v);
            Choice("Frame rate cap", new[] { "15", "24", "30", "60" }, new[] { "15 fps", "24 fps", "30 fps", "60 fps" },
                s.MaxFps.ToString(), v => s.MaxFps = int.Parse(v));
            Folder("Web files folder", s.WebFolder, v => s.WebFolder = v);

            var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 12, 0, 0) };
            var ok = new Button { Text = "OK", DialogResult = DialogResult.OK };
            var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel };
            var preview = new Button { Text = "Preview", AutoSize = true };
            ok.Click += (_, __) => { s.Save(); Close(); };
            preview.Click += (_, __) => { s.Save(); Program.Preview(); };
            buttons.Controls.AddRange(new Control[] { cancel, ok, preview });
            grid.Controls.Add(buttons);
            grid.SetColumnSpan(buttons, 3);
            AcceptButton = ok;
            CancelButton = cancel;
        }

        void Row(string label, Control input, Control extra = null)
        {
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 12, 6) });
            input.Dock = DockStyle.Fill;
            grid.Controls.Add(input);
            grid.Controls.Add(extra ?? new Label { AutoSize = true });
        }

        void Heading(string text)
        {
            var l = new Label { Text = text, AutoSize = true, Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 10, 0, 4) };
            grid.Controls.Add(l);
            grid.SetColumnSpan(l, 3);
        }

        void Slider(string label, int value, Action<int> set)
        {
            var bar = new TrackBar { Minimum = 0, Maximum = 100, TickFrequency = 10, Value = Math.Clamp(value, 0, 100), AutoSize = false, Height = 30 };
            var shown = new Label { Text = bar.Value + "%", AutoSize = true, Anchor = AnchorStyles.Left, MinimumSize = new Size(40, 0) };
            bar.ValueChanged += (_, __) => { set(bar.Value); shown.Text = bar.Value + "%"; };
            Row(label, bar, shown);
        }

        void Number(string label, int value, int min, int max, Action<int> set)
        {
            var n = new NumericUpDown { Minimum = min, Maximum = max, Value = Math.Clamp(value, min, max), Width = 80, Dock = DockStyle.None, Anchor = AnchorStyles.Left };
            n.ValueChanged += (_, __) => set((int)n.Value);
            Row(label, n);
            n.Dock = DockStyle.None;
        }

        void Choice(string label, string[] values, string[] names, string current, Action<string> set)
        {
            var box = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
            box.Items.AddRange(names);
            box.SelectedIndex = Math.Max(0, Array.IndexOf(values, current));
            box.SelectedIndexChanged += (_, __) => set(values[box.SelectedIndex]);
            Row(label, box);
        }

        void Folder(string label, string current, Action<string> set)
        {
            var text = new TextBox { Text = current, PlaceholderText = "(default: the web folder next to treeps1.scr)" };
            text.TextChanged += (_, __) => set(text.Text.Trim());
            var browse = new Button { Text = "Browse...", AutoSize = true };
            browse.Click += (_, __) =>
            {
                using var dlg = new FolderBrowserDialog { Description = "Folder containing index.html and src", UseDescriptionForTitle = true };
                if (dlg.ShowDialog(this) == DialogResult.OK) text.Text = dlg.SelectedPath;
            };
            Row(label, text, browse);
        }
    }
}
