#!/bin/bash
# build.sh -- builds JXPI file for seafile filelink extension
#
# Base on a script from mozilla see: <http://kb.mozillazine.org/Bash_build_script>
#
# usage :
# $ ./build.sh
# will generate seafile_for_filelink-currentbuildtime-tb.xpi
#
# passing a string argument :
# $ ./build sh last
# will generate seafile_for_filelink-last-tb.xpi

buildid=$1
[[ "$buildid" == "" ]] && buildid=`date +%Y%m%d`
xpifile=seafile_for_filelink-$buildid-tb.xpi
rm $xpifile
cd cloudfile-seafile@oregpreshaz.eu
zip -r ../$xpifile . -x "CVS"
cd ..
echo -n Created file:
ls "$xpifile"
