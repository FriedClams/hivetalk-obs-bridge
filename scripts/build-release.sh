#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(node -p "require('$project_dir/package.json').version")"
release_name="hivetalk-obs-bridge-v${version}"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

# Give every archived file the same timestamp so two builds from the same
# source revision produce byte-identical ZIP/XPI files. SOURCE_DATE_EPOCH is
# supported by reproducible-build tooling; fall back to the current Git commit.
source_date_epoch="${SOURCE_DATE_EPOCH:-}"
if [[ -z "$source_date_epoch" ]] && git -C "$project_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  source_date_epoch="$(git -C "$project_dir" log -1 --format=%ct)"
fi
source_date_epoch="${source_date_epoch:-315532800}"

mkdir -p "$project_dir/dist" "$temporary_dir/$release_name" "$temporary_dir/extension"
cp -a "$project_dir/extension/." "$temporary_dir/extension/"

cp -a "$project_dir/.github" "$project_dir/docs" "$project_dir/extension" "$project_dir/scripts" "$project_dir/server" "$project_dir/test" "$project_dir/.gitignore" "$project_dir/KNOWN_ISSUES.md" "$project_dir/LICENSE" "$project_dir/README.md" "$project_dir/SECURITY.md" "$project_dir/package.json" "$project_dir/package-lock.json" "$temporary_dir/$release_name/"

find "$temporary_dir/extension" "$temporary_dir/$release_name" -exec touch -h -d "@$source_date_epoch" {} +

(
  cd "$temporary_dir/extension"
  find . -type f -print | LC_ALL=C sort | zip -q -X "$temporary_dir/hivetalk-obs-bridge-firefox-v${version}.xpi" -@
)

cp "$temporary_dir/hivetalk-obs-bridge-firefox-v${version}.xpi" "$temporary_dir/$release_name/"
touch -h -d "@$source_date_epoch" "$temporary_dir/$release_name/hivetalk-obs-bridge-firefox-v${version}.xpi"

(
  cd "$temporary_dir"
  find "$release_name" -type f -print | LC_ALL=C sort | zip -q -X "$temporary_dir/${release_name}.zip" -@
  sha256sum "hivetalk-obs-bridge-firefox-v${version}.xpi" "${release_name}.zip" > SHA256SUMS
)

cp "$temporary_dir/hivetalk-obs-bridge-firefox-v${version}.xpi" "$project_dir/dist/"
cp "$temporary_dir/${release_name}.zip" "$project_dir/dist/"
cp "$temporary_dir/SHA256SUMS" "$project_dir/dist/"

echo "Built release files in $project_dir/dist"
