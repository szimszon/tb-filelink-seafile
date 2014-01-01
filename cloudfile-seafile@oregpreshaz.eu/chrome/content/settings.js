/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Based on https://mxr.mozilla.org/comm-central/source/mail/components/cloudfile/content/YouSendIt/settings.js
 * Edited by Szabolcs Gyuris (szimszon at oregpreshaz dot eu)
 */

function extraArgs() {
  var usernameValue = document.getElementById("username").value.trim();
  var baseURL = document.getElementById("baseURL").value.trim();
  if (baseURL && baseURL[baseURL.length - 1] != '/') {
    baseURL += "/";
  }
  var libraryValue = document.getElementById("library").value.trim();
  return {
    "baseURL": { type: "char", value: baseURL },
    "username": { type: "char", value: usernameValue },
    "library": { type: "char", value: libraryValue },
  };  
}
