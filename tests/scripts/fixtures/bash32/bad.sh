#!/usr/bin/env bash
declare -A values
mapfile -t lines < input.txt
readarray -t more_lines < input.txt
lower="${value,,}"
upper="${value^^}"
command &>> output.log
