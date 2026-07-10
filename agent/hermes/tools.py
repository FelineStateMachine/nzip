"""CLI-backed implementations for the shared nzip tool contract."""

import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if not (ROOT / "tools.json").exists():
    ROOT = ROOT.parent


def definitions():
    return json.loads((ROOT / "tools.json").read_text())


def _string(args, name, required=False):
    value = args.get(name)
    if value is None:
        if required:
            raise ValueError(f"{name} is required")
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _ttl(args):
    value = _string(args, "ttl")
    if value and value != "forever" and value != "0":
        if not (value.rstrip("d").isdigit() and value.count("d") <= 1):
            raise ValueError("ttl must be a number of days or forever")
    return value


def _run(command):
    result = subprocess.run(["nzip", *command, "--json"], capture_output=True, text=True, check=False)
    body = (result.stdout or result.stderr).strip()
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as error:
        raise RuntimeError(body or f"nzip exited with status {result.returncode}") from error
    if result.returncode or parsed.get("ok") is False:
        raise RuntimeError(parsed.get("error", "nzip command failed"))
    return parsed


def _host_html(args):
    html = _string(args, "html", required=True)
    target, ttl, password = _string(args, "target"), _ttl(args), _string(args, "password")
    with tempfile.TemporaryDirectory(prefix="nzip-agent-") as directory:
        page = Path(directory) / "index.html"
        page.write_text(html)
        command = ["push", str(page)]
        if target:
            command.append(target)
        if ttl:
            command.extend(["--ttl", ttl])
        hosted = _run(command)
        return _run(["share", hosted["address"], "--password", password]) if password else hosted


def invoke(name, args):
    if not isinstance(args, dict):
        raise ValueError("arguments must be an object")
    if name == "status":
        return _run(["status"])
    if name == "list_vaults":
        return _run(["vault", "ls"])
    if name == "list_sites":
        vault = _string(args, "vault")
        return _run(["ls", vault] if vault else ["ls"])
    if name == "inspect_site":
        return _run(["share", _string(args, "target", required=True)])
    if name == "host_html":
        return _host_html(args)
    if name == "configure_site":
        target, ttl, password = _string(args, "target", required=True), _ttl(args), args.get("password")
        if not ttl and password is None and "password" not in args:
            raise ValueError("configure_site requires ttl or password")
        command = ["share", target]
        if ttl:
            command.extend(["--ttl", ttl])
        if password is None and "password" in args:
            command.append("--no-password")
        elif isinstance(password, str) and password:
            command.extend(["--password", password])
        elif password is not None:
            raise ValueError("password must be a string or null")
        return _run(command)
    if name == "download_site":
        command = ["download", _string(args, "target", required=True)]
        directory = _string(args, "directory")
        if directory:
            command.append(directory)
        if args.get("overwrite") is True:
            command.append("--overwrite")
        return _run(command)
    if name == "restore_site":
        command = ["revert", _string(args, "target", required=True)]
        if "to" in args:
            if not isinstance(args["to"], int) or args["to"] < 1:
                raise ValueError("to must be a positive integer")
            command.extend(["--to", str(args["to"])])
        return _run(command)
    if name == "delete_site":
        if args.get("confirm") is not True:
            raise ValueError("delete_site requires confirm: true")
        return _run(["rm", _string(args, "target", required=True), "--yes"])
    raise ValueError(f"unknown nzip tool: {name}")
