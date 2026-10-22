"""Read the same release contract as Node and verify uploaded bytes without dependencies."""
import hashlib
import json
import os
import re
import stat
from pathlib import Path

CONTRACT = json.loads(Path(__file__).with_name("contract.json").read_text(encoding="utf-8"))


def release_id(value):
    if not isinstance(value, str) or not re.fullmatch(CONTRACT["releasePattern"], value):
        raise ValueError("Invalid release ID")
    return value


def safe_path(value):
    if not isinstance(value, str) or not value or any(
        not re.fullmatch(CONTRACT["segmentPattern"], part) for part in value.split("/")
    ):
        raise ValueError("Unsafe artifact path: " + str(value))
    return value


def real_directory(value):
    directory = Path(value).absolute()
    if not stat.S_ISDIR(directory.lstat().st_mode):
        raise ValueError("Expected real directory: " + str(directory))
    return directory.resolve()


def open_safe(root, relative):
    current = root
    for part in safe_path(relative).split("/"):
        current = current / part
        if stat.S_ISLNK(current.lstat().st_mode):
            raise ValueError("Symbolic links are forbidden: " + relative)
    descriptor = os.open(current, os.O_RDONLY | os.O_NOFOLLOW)
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise ValueError("Not a regular file: " + relative)
    return os.fdopen(descriptor, "rb")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key: " + key)
        result[key] = value
    return result


def metadata(filename):
    safe_path(filename)
    encoding = "br" if filename.endswith(".br") else "gzip" if filename.endswith(".gz") else None
    original = filename[:-3] if encoding else filename
    first = original.split("/")[0]
    if first.lower() in CONTRACT["privateRoots"] or (
        "/" in original and first not in CONTRACT["publicDirectories"]
    ):
        raise ValueError("Not a public build artifact: " + filename)
    content_type = CONTRACT["contentTypes"].get(Path(original).suffix.lower())
    if not content_type or (original.lower().endswith(".html") and original != "index.html"):
        raise ValueError("Unsupported public artifact: " + filename)
    return content_type, encoding, bool(re.fullmatch(CONTRACT["immutablePattern"], original))


def validate_manifest(manifest):
    if not isinstance(manifest, dict) or type(manifest.get("schemaVersion")) is not int or (
        manifest["schemaVersion"] != CONTRACT["schemaVersion"]
    ) or not isinstance(manifest.get("files"), list) or not manifest["files"]:
        raise ValueError("Invalid release manifest")
    release_id(manifest.get("release"))
    seen = set()
    for entry in manifest["files"]:
        if not isinstance(entry, dict) or set(entry) != set(CONTRACT["fileFields"]):
            raise ValueError("Invalid manifest file fields")
        filename = safe_path(entry["path"])
        if filename in seen:
            raise ValueError("Duplicate manifest path: " + filename)
        seen.add(filename)
        if type(entry["size"]) is not int or not 0 <= entry["size"] <= 9007199254740991 or (
            not isinstance(entry["sha256"], str) or not re.fullmatch("[a-f0-9]{64}", entry["sha256"])
        ):
            raise ValueError("Invalid checksum metadata: " + filename)
        expected = metadata(filename)
        if type(entry["immutable"]) is not bool or (entry["contentType"], entry["encoding"], entry["immutable"]) != expected:
            raise ValueError("Invalid public file metadata: " + filename)
    if "index.html" not in seen:
        raise ValueError("Missing index.html")
    for entry in manifest["files"]:
        if entry["encoding"] and entry["path"][:-3] not in seen:
            raise ValueError("Missing original for compressed asset: " + entry["path"])
    serialized = json.dumps(manifest["files"], separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    if hashlib.sha256(serialized.encode("utf-8")).hexdigest() != manifest.get("artifactSha256"):
        raise ValueError("Manifest checksum mismatch")
    return manifest


def verify_file(root, relative, entry):
    digest, length = hashlib.sha256(), 0
    with open_safe(root, relative) as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
            length += len(chunk)
    if length != entry["size"] or digest.hexdigest() != entry["sha256"]:
        raise ValueError("Artifact checksum mismatch: " + relative)


def walk_files(root, prefix=""):
    files = set()
    for entry in os.scandir(root / prefix):
        relative = safe_path(prefix + "/" + entry.name if prefix else entry.name)
        if entry.is_symlink():
            raise ValueError("Symbolic links are forbidden: " + relative)
        if entry.is_dir(follow_symlinks=False):
            files.update(walk_files(root, relative))
        elif entry.is_file(follow_symlinks=False):
            files.add(relative)
        else:
            raise ValueError("Not a regular file: " + relative)
    return files


def verify_bundle(bundle, expected_release=None):
    root = real_directory(bundle)
    if set(os.listdir(root)) != {"manifest.json", "files"}:
        raise ValueError("Release must contain only manifest.json and files")
    with open_safe(root, "manifest.json") as handle:
        manifest = validate_manifest(json.load(handle, object_pairs_hook=unique_object))
    if expected_release is not None and manifest["release"] != expected_release:
        raise ValueError("Release directory and manifest ID differ")
    files_root = real_directory(root / "files")
    if walk_files(files_root) != {entry["path"] for entry in manifest["files"]}:
        raise ValueError("Artifact file list differs from manifest")
    for entry in manifest["files"]:
        verify_file(files_root, entry["path"], entry)
    return manifest
