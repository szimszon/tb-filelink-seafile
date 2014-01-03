SeaFile for Filelink in Thunderbird
===================================

Not a product from SeaFile.com!

SeaFile is a Next-generation Open Source Cloud Storage see here: http://seafile.com/en/home/

Adds the possibility to use a SeaFile store for Filelink.

This is a highly experimental extension for thunderbird. It is based heavily on YouSendIt implementation (http://mxr.mozilla.org/comm-central/source/mail/components/cloudfile/nsYouSendIt.js).

Install
-------

Go to the http://store.oregpreshaz.eu/seafile_for_filelink/ site and download the xpi. Than install it in Thunderbird.

Or grab the code:

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

Contact
-------

* Szabolcs Gyuris <cloudfile-seafile@oregpreshaz.eu>

Known issuses
-------------

* upload file with the same filename multiple times results in "same file name (1)..." "same file name (2)..." in the library but Thunderbird always get the original file's download link
* if you ask thunderbird to convert the attachements from local to SeaFile file by file than you could end up some files uploaded multiple times and Thunderbird will place some files link's multiple times. Workaround is to add all required attachements to the letter. Select all and then convert all to SeaFile in one step
* didn't work with international filenames
