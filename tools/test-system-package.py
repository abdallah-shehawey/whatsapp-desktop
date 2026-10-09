#!/usr/bin/env python3
"""Exercise a source-only install and the launcher's actual argv/environment."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
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
    stage = tmp / "stage"
    subprocess.run(["make", "install-system", "PREFIX=/usr", f"DESTDIR={stage}",
                    f"SYSTEM_ELECTRON={runtime}"], cwd=source, check=True)
    launcher = stage / "usr/bin/whatsapp-desktop"
    desktop = stage / "usr/share/applications/io.github.shehawey.whatsapp-desktop.desktop"
    assert "StartupWMClass=WhatsApp\n" in desktop.read_text()
    expected_version = json.loads((root / "package.json").read_text())["version"]
    assert subprocess.check_output([launcher, "--version"], text=True).strip() == \
        f"whatsapp-desktop {expected_version}"
    assert "--hidden" in subprocess.check_output([launcher, "--help"], text=True)
    assert not (source / "node_modules").exists(), "install must not fetch Electron"
    for file in stage.rglob("*"):
        if file.is_file():
            assert file.read_bytes()[:4] != b"\x7fELF", f"bundled binary: {file}"
            assert file.name != "chrome-sandbox", "sandbox is owned by Electron"

    xdg = tmp / "data with spaces"
    (xdg / "whatsapp-desktop").mkdir(parents=True)
    fontconfig = xdg / "whatsapp-desktop/fonts.conf"
    fontconfig.write_text("<fontconfig/>\n")
    env = dict(os.environ, XDG_DATA_HOME=str(xdg), ELECTRON_RUN_AS_NODE="1")
    result = json.loads(subprocess.check_output([
        launcher, "--hidden", "whatsapp://send?phone=123&text=hello world"
    ], env=env, text=True))
    assert result["argv"] == [
        "/usr/share/whatsapp-desktop",
        "--class=io.github.shehawey.whatsapp-desktop", "--name=whatsapp-desktop",
        "--hidden", "whatsapp://send?phone=123&text=hello world"
    ]
    assert result["as_node"] is None
    assert result["fontconfig"] == str(fontconfig)
    assert "--no-sandbox" not in result["argv"]

    subprocess.run(["desktop-file-validate", stage / "usr/share/applications/"
                    "io.github.shehawey.whatsapp-desktop.desktop"], check=True)
    subprocess.run(["appstreamcli", "validate", "--no-net", stage / "usr/share/metainfo/"
                    "io.github.shehawey.whatsapp-desktop.metainfo.xml"], check=True)
print("source-only installation and launcher checks pass")
