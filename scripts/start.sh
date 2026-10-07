#!/bin/sh
# Run only in an operationally approved environment after reviewing the runbook.
set -eu
cd "$(dirname "$0")/.."
test -f .env || { echo 'Provide a reviewed deployment environment first' >&2; exit 1; }
docker compose version >/dev/null
docker compose -f docker-compose.yml -f docker-compose.qualified.yml --profile operations config --quiet
docker compose -f docker-compose.yml -f docker-compose.qualified.yml --profile operations config --format json | node -e '
let config; try {config=JSON.parse(require("node:fs").readFileSync(0,"utf8"));} catch {console.error("Qualified configuration could not be parsed");process.exit(1);}
for(const name of ["api","internal","worker","migrate","maintenance","postfix","policy","opendkim","journal-maintenance","postgres","redis"]) {
  if(!config.services[name] || config.services[name].build || !/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64})$/.test(config.services[name].image)) {
    console.error("An immutable qualified image is required"); process.exit(1);
  }
}'
docker compose -f docker-compose.yml -f docker-compose.qualified.yml up -d --no-build --pull never --wait
docker compose -f docker-compose.yml -f docker-compose.qualified.yml ps
