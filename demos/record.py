#!/usr/bin/env python3
"""Record the README's demo GIFs: drive VS Code on the virtual screen (desktop.sh) with xdotool,
record it with ffmpeg, and turn each clip into a GIF. Runs inside the container (record.sh).

Click positions are for the 1280x800 screen at window.zoomLevel 1 with the settings in
desktop.sh; if VS Code's layout changes, take screenshots (shot()) and adjust them."""

import os
import subprocess
import sys
import time

OUT = "/out"
ENV = dict(os.environ, DISPLAY=":99", XCURSOR_THEME="DMZ-White", XCURSOR_SIZE="24")
PROJECT = os.path.expanduser("~/tiny-weather")
pointer = [640, 400]


def x(*args):
    subprocess.run(["xdotool", *map(str, args)], env=ENV, check=True)


def move(tx, ty, seconds=0.45):
    """Glide the pointer to (TX, TY), easing in and out, as a hand would."""
    steps = max(2, int(seconds * 40))
    sx, sy = pointer
    for i in range(1, steps + 1):
        t = i / steps
        e = t * t * (3 - 2 * t)
        x("mousemove", round(sx + (tx - sx) * e), round(sy + (ty - sy) * e))
        time.sleep(seconds / steps)
    pointer[:] = [tx, ty]


def click(tx, ty, button=1, pause=0.15):
    move(tx, ty)
    time.sleep(pause)
    x("click", button)


def drag(fx, fy, tx, ty):
    move(fx, fy)
    time.sleep(0.15)
    x("mousedown", 1)
    move(tx, ty, seconds=0.9)
    x("mouseup", 1)


def scroll(notches, delay=0.09):
    for _ in range(notches):
        x("click", 5)
        time.sleep(delay)


def wait(seconds):
    time.sleep(seconds)


def shot(name):
    subprocess.run(["import", "-window", "root", f"{OUT}/{name}.png"], env=ENV, check=True)


def start_vscode():
    """A fresh project and a fresh VS Code window on it (the same starting point for every clip)."""
    # Quit the last window, and wait until VS Code has really gone: a new `code` started while the
    # old one is still exiting joins it, and its window dies with it
    subprocess.run(["pkill", "-f", "/usr/share/code/code"], check=False)
    for _ in range(40):
        if subprocess.run(["pgrep", "-f", "/usr/share/code/code"], stdout=subprocess.DEVNULL).returncode != 0:
            break
        wait(0.25)
    else:
        subprocess.run(["pkill", "-9", "-f", "/usr/share/code/code"], check=False)
        wait(1)
    subprocess.run(["/demos/make-project.sh", PROJECT], check=True, stdout=subprocess.DEVNULL)
    for f in os.listdir(os.path.expanduser("~/printouts")):
        os.remove(os.path.join(os.path.expanduser("~/printouts"), f))
    subprocess.Popen(["code", "--no-sandbox", "--disable-gpu", "--password-store=basic", "--disable-workspace-trust", PROJECT],
                     env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait(9)
    x("mousemove", 640, 400)
    pointer[:] = [640, 400]


class Recording:
    def __init__(self, name):
        self.name = name

    def __enter__(self):
        self.ffmpeg = subprocess.Popen(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "1", "-framerate", "25",
             "-video_size", "1280x800", "-i", ":99", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
             "-pix_fmt", "yuv420p", f"{OUT}/{self.name}.mp4"],
            stdin=subprocess.PIPE, env=ENV)
        wait(0.8)
        return self

    def __exit__(self, *exc):
        self.ffmpeg.communicate(b"q")
        palette = f"/tmp/{self.name}-palette.png"
        scale = "fps=12,scale=960:-1:flags=lanczos"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{OUT}/{self.name}.mp4",
                        "-vf", f"{scale},palettegen=stats_mode=diff", palette], check=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{OUT}/{self.name}.mp4", "-i", palette,
                        "-lavfi", f"{scale}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
                        f"{OUT}/{self.name}.gif"], check=True)
        print(f"{self.name}.gif: {os.path.getsize(f'{OUT}/{self.name}.gif') / 1e6:.1f} MB")


def warm_up():
    """The first print after an update from version 1 shows a one-time note: get it out of the way."""
    start_vscode()
    click(111, 121, button=3)
    wait(1)
    click(193, 510)
    wait(4)
    x("key", "Escape")


def demo_folder():
    start_vscode()
    with Recording("demo-folder"):
        wait(0.6)
        click(111, 121, button=3)          # right-click src
        wait(1.2)
        click(193, 510)                    # Print to PDF
        wait(2.6)                          # the contents page
        move(820, 450)
        scroll(19, delay=0.07)             # down to api.py
        move(1180, 700)                    # out of the way
        wait(2.6)


def demo_choose():
    start_vscode()
    with Recording("demo-choose"):
        wait(0.6)
        click(200, 420, button=3)          # right-click the project
        wait(1.0)
        click(360, 778)                    # Choose Files and Print to PDF…
        wait(1.4)
        click(302, 152)                    # uncheck pyproject.toml
        wait(0.5)
        click(302, 284)                    # uncheck tests/test_format.py
        move(700, 230)
        wait(0.9)
        click(973, 90)                     # OK
        move(1180, 700, seconds=0.6)
        wait(2.6)


def demo_selection():
    start_vscode()
    with Recording("demo-selection"):
        wait(0.5)
        click(111, 121)                    # open src/weather
        wait(0.5)
        click(133, 174)                    # api.py
        wait(1.2)
        drag(465, 302, 610, 432)           # select lines 11-17
        wait(0.6)
        click(540, 370, button=3)
        wait(1.1)
        click(661, 461)                    # Print Selection to PDF
        wait(1.8)
        click(829, 96)                     # zoom in, twice
        wait(0.3)
        click(829, 96)
        move(1180, 700)
        wait(2.6)


def demo_changes():
    start_vscode()
    with Recording("demo-changes"):
        wait(0.5)
        click(31, 166)                     # Source Control
        wait(1.0)
        click(354, 91)                     # the repository's … menu
        wait(1.2)
        click(470, 619)                    # Print Changes to PDF…
        wait(1.6)
        click(362, 150)                    # The last commit
        wait(2.2)
        move(820, 450)
        scroll(12)                         # down to the marked lines
        move(1180, 700)                    # out of the way
        wait(2.8)


if __name__ == "__main__":
    names = sys.argv[1:] or ["folder", "choose", "selection", "changes"]
    warm_up()
    for name in names:
        globals()[f"demo_{name}"]()
