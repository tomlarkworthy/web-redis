#!/bin/bash
# https://vaneyckt.io/posts/safer_bash_scripts_with_set_euxo_pipefail/
set -euxo pipefail

curl 'https://webcode.run/observablehq.com/@tomlarkworthy/distiller?notebook=@tomlarkworthy/redis&entryPoint=createClient' \
     > index.js