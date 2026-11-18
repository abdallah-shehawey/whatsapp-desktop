#!/usr/bin/env python3
"""Exercise a source-only install and the launcher's actual argv/environment,
under the default brand and under the brand the distribution archives take."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
expected_version = json.loads((root / "package.json").read_text())["version"]

# What each brand's install has to come out as.
BRANDS = {
    "whatsapp": dict(bin="whatsapp-desktop", id="io.github.shehawey.whatsapp-desktop",
                     name="WhatsApp", wm_class="WhatsApp"),
    "dardasha": dict(bin="dardasha", id="io.github.abdallah_shehawey.dardasha",
                     name="Dardasha", wm_class="Dardasha"),
}


def releases(metainfo: str) -> list:
    return re.findall(r'<release version="([^"]+)"', metainfo)


def check(brand: str, source: Path, tmp: Path, runtime: Path) -> None:
    want = BRANDS[brand]
    stage = tmp / f"stage-{brand}"
    subprocess.run(["make", "install-system", f"BRAND={brand}", "PREFIX=/usr",
                    f"DESTDIR={stage}", f"SYSTEM_ELECTRON={runtime}"], cwd=source, check=True)
    launcher = stage / "usr/bin" / want["bin"]
    appdir = stage / "usr/share" / want["bin"]
    desktop = stage / "usr/share/applications" / f"{want['id']}.desktop"
    metainfo = stage / "usr/share/metainfo" / f"{want['id']}.metainfo.xml"
    entry = desktop.read_text()
    assert f"StartupWMClass={want['wm_class']}\n" in entry
    assert f"\nName={want['name']}\n" in entry
    assert f"\nIcon={want['id']}\n" in entry
    assert f"\nExec=/usr/bin/{want['bin']} %u\n" in entry
    assert subprocess.check_output([launcher, "--version"], text=True).strip() == \
        f"{want['bin']} {expected_version}"
    assert "--hidden" in subprocess.check_output([launcher, "--help"], text=True)
    assert not (source / "node_modules").exists(), "install must not fetch Electron"
    for file in stage.rglob("*"):
        if file.is_file():
            assert file.read_bytes()[:4] != b"\x7fELF", f"bundled binary: {file}"
            assert file.name != "chrome-sandbox", "sandbox is owned by Electron"

    # The installed copy is the brand it was installed as, and carries no other.
    installed = json.loads((appdir / "data/brand.json").read_text())
    assert (installed["id"], installed["name"], installed["bin"]) == \
        (want["id"], want["name"], want["bin"])
    assert not (appdir / "data/brands").exists(), "other brands are not the runtime's"
    icons = {p.name for p in (stage / "usr/share/icons/hicolor").rglob("*.png")}
    assert f"{want['id']}.png" in icons and f"{want['id']}-tray-attention.png" in icons
    app_icons = {p.name for p in (appdir / "data/icons").rglob("*.png")}
    assert app_icons == icons, "the app reads the same icons the theme installs"
    for other, info in BRANDS.items():
        if other != brand:
            assert not any(info["id"] in name for name in icons | app_icons), other
            assert not (appdir / "data" / f"{info['id']}.desktop").exists(), other
    name = subprocess.check_output(["node", "-p", "require(process.argv[1]).name",
                                    appdir / "src/brand.js"], text=True).strip()
    assert name == want["name"]
    # The client's own pages: a marked element names the installed brand.
    page = subprocess.check_output(["node", "-e", """
        const els = [{ textContent: 'WhatsApp Settings' }, { textContent: 'About WhatsApp' }];
        require(process.argv[1]).brandDocument({ readyState: 'complete', querySelectorAll: () => els });
        console.log(els.map(e => e.textContent).join('|'));
    """, appdir / "src/brand.js"], text=True).strip()
    assert page == f"{want['name']} Settings|About {want['name']}", page

    # Every brand's metadata lists the same releases, recorded once.
    text = metainfo.read_text()
    assert f"<id>{want['id']}</id>" in text
    assert "@RELEASES@" not in text
    default = (root / "data/io.github.shehawey.whatsapp-desktop.metainfo.xml").read_text()
    assert releases(text) == releases(default) and releases(text)[0] == expected_version

    xdg = tmp / f"data with spaces {brand}"
    (xdg / "whatsapp-desktop").mkdir(parents=True)
    fontconfig = xdg / "whatsapp-desktop/fonts.conf"
    fontconfig.write_text("<fontconfig/>\n")
    env = dict(os.environ, XDG_DATA_HOME=str(xdg), ELECTRON_RUN_AS_NODE="1")
    result = json.loads(subprocess.check_output([
        launcher, "--hidden", "whatsapp://send?phone=123&text=hello world"
    ], env=env, text=True))
    assert result["argv"] == [
        f"/usr/share/{want['bin']}",
        f"--class={want['id']}", f"--name={want['bin']}",
        "--hidden", "whatsapp://send?phone=123&text=hello world"
    ]
    assert result["as_node"] is None
    assert result["fontconfig"] == str(fontconfig)
    assert "--no-sandbox" not in result["argv"]

    subprocess.run(["desktop-file-validate", desktop], check=True)
    subprocess.run(["appstreamcli", "validate", "--no-net", metainfo], check=True)


with tempfile.TemporaryDirectory(prefix="whatsapp-system-package-") as tmp:
    tmp = Path(tmp)
    source = tmp / "source"
    source.mkdir()
    for name in ("Makefile", "package.json", "src", "data", "packaging"):
        item = root / name
        if item.is_dir():
            shutil.copytree(item, source / name)
        else:
            shutil.copy2(item, source / name)

    runtime = tmp / "runtime with spaces"
    runtime.write_text("#!/usr/bin/env python3\nimport os,sys,json\n"
                       "print(json.dumps({'argv':sys.argv[1:], "
                       "'as_node':os.environ.get('ELECTRON_RUN_AS_NODE'), "
                       "'fontconfig':os.environ.get('FONTCONFIG_FILE')}))\n")
    runtime.chmod(0o755)
    for brand in BRANDS:
        check(brand, source, tmp, runtime)
print("source-only installation and launcher checks pass, for both brands")
