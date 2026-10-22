#!/usr/bin/env python3
"""Install verified frontend releases on a POSIX host with Python 3 only."""
import argparse
import json
import os
import shutil
import stat
import sys
import uuid
from pathlib import Path

sys.dont_write_bytecode = True
from remote_manifest import open_safe, real_directory, release_id, safe_path, verify_bundle, verify_file


def ensure_directory(root, relative):
    current = root
    for part in safe_path(relative).split("/"):
        current = current / part
        try:
            current.mkdir(mode=0o755)
            current.chmod(0o755)
        except FileExistsError:
            pass
        if not stat.S_ISDIR(current.lstat().st_mode):
            raise ValueError("Unsafe directory: " + str(current))
    return current


def exists(filename):
    return os.path.lexists(filename)


def current_release(root):
    current = root / "current"
    if not exists(current):
        return None
    if not stat.S_ISLNK(current.lstat().st_mode):
        raise ValueError("current must be a release symlink")
    target = os.readlink(current)
    if not target.startswith("releases/"):
        raise ValueError("Unsafe current release pointer")
    return release_id(target[len("releases/"):])


def copy_file(source_root, relative, destination):
    with open_safe(source_root, relative) as source:
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        with os.fdopen(descriptor, "wb") as output:
            os.fchmod(output.fileno(), 0o644)
            shutil.copyfileobj(source, output, 1024 * 1024)
            output.flush()
            os.fsync(output.fileno())


def verify_shared(root, manifest):
    for entry in manifest["files"]:
        if entry["immutable"]:
            verify_file(root, "shared/files/" + entry["path"], entry)


def install_shared(root, source, manifest):
    for entry in manifest["files"]:
        if not entry["immutable"]:
            continue
        relative = "shared/files/" + entry["path"]
        destination = root / relative
        ensure_directory(root, str(Path(relative).parent))
        temporary = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            copy_file(source / "files", entry["path"], temporary)
            verify_file(root, str(temporary.relative_to(root)), entry)
            try:
                os.link(temporary, destination)
            except FileExistsError:
                verify_file(root, relative, entry)
        finally:
            if exists(temporary):
                temporary.unlink()


def stage(root, bundle):
    source = real_directory(bundle)
    manifest = verify_bundle(source)
    for directory in ("releases", "staging", "shared/files"):
        ensure_directory(root, directory)
    destination = root / "releases" / manifest["release"]
    if exists(destination):
        retained = verify_bundle(destination, manifest["release"])
        if retained["artifactSha256"] != manifest["artifactSha256"]:
            raise ValueError("Release ID already contains different artifacts")
        verify_shared(root, retained)
        return {"release": manifest["release"], "artifactSha256": manifest["artifactSha256"], "reused": True}
    # Check every collision before installing any new shared file.
    for entry in manifest["files"]:
        relative = "shared/files/" + entry["path"]
        if entry["immutable"] and exists(root / relative):
            try:
                verify_file(root, relative, entry)
            except ValueError as error:
                raise ValueError("Immutable asset conflict: " + entry["path"]) from error
    temporary = ensure_directory(root, "staging/" + manifest["release"] + "-" + uuid.uuid4().hex)
    try:
        ensure_directory(temporary, "files")
        for entry in manifest["files"]:
            relative = "files/" + entry["path"]
            ensure_directory(temporary, str(Path(relative).parent))
            copy_file(source, relative, temporary / relative)
        copy_file(source, "manifest.json", temporary / "manifest.json")
        staged = verify_bundle(temporary, manifest["release"])
        if staged["artifactSha256"] != manifest["artifactSha256"]:
            raise ValueError("Uploaded manifest changed while staging")
        install_shared(root, temporary, manifest)
        verify_shared(root, manifest)
        os.rename(temporary, destination)
        return {"release": manifest["release"], "artifactSha256": manifest["artifactSha256"], "reused": False}
    finally:
        if exists(temporary):
            shutil.rmtree(temporary)


def activate(root, release):
    release_id(release)
    ensure_directory(root, "releases")
    manifest = verify_bundle(root / "releases" / release, release)
    verify_shared(root, manifest)
    previous = current_release(root)
    temporary = root / (".current-" + uuid.uuid4().hex)
    try:
        os.symlink("releases/" + release, temporary)
        os.replace(temporary, root / "current")
    finally:
        if exists(temporary):
            temporary.unlink()
    return {"release": release, "previousRelease": previous, "artifactSha256": manifest["artifactSha256"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("verify", "stage", "install", "activate", "rollback"):
        command_parser = commands.add_parser(command)
        if command in ("verify", "stage", "install"):
            command_parser.add_argument("--bundle", required=True, help="Uploaded directory containing manifest.json and files/")
        if command != "verify":
            command_parser.add_argument("--root", required=True, help="Dedicated project frontend directory")
        if command in ("activate", "rollback"):
            command_parser.add_argument("--release", required=True)
    args = parser.parse_args()
    if args.command == "verify":
        manifest = verify_bundle(args.bundle)
        return {"command": args.command, "release": manifest["release"], "artifactSha256": manifest["artifactSha256"]}
    root = Path(args.root).absolute()
    try:
        root.mkdir(mode=0o755)
        root.chmod(0o755)
    except FileExistsError:
        pass
    root = real_directory(root)
    lock = root / ".publish-lock"
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError as error:
        raise ValueError("Release operation already locked; inspect an interrupted operation before removing .publish-lock") from error
    try:
        if args.command in ("stage", "install"):
            result = stage(root, args.bundle)
            if args.command == "install":
                result = activate(root, result["release"])
        else:
            result = activate(root, args.release)
        return {"command": args.command, **result}
    finally:
        lock.rmdir()


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, **main()}, separators=(",", ":")))
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")), file=sys.stderr)
        sys.exit(1)
