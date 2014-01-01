SeaFile for Filelink in Thunderbird
===================================

SeaFile is a Next-generation Open Source Cloud Storage see here: http://seafile.com/en/home/

Install
-------

Adds the possibility to use a SeaFile store for Filelink.

This is a highly experimental extension for thunderbird. It is based heavily on YouSendIt implementation (http://mxr.mozilla.org/comm-central/source/mail/components/cloudfile/nsYouSendIt.js).

For now you can only get the code:

https://github.com/szimszon/tb-filelink-seafile/archive/master.zip

and copy the content under extensions directory in thunderbird's profile folder.

Name the directory: cloudfile-seafile@oregpreshaz.eu

Please help fork and contribute. (I'm not an experienced TB Add-on developer)

Thank you!

Usage
-----

You need a SeaFile server with an account and a not encrypted library with read-write permission.

The add-on creates a directory in the library with the name "/apps/mozilla_thunderbird".
All files go to this directory.
