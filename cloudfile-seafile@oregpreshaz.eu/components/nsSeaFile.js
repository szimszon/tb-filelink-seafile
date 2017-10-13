/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* This file implements the nsIMsgCloudFileProvider interface.
 *
 * This component handles the SeaFile implementation of the
 * nsIMsgCloudFileProvider interface.
 * This code is based of a YouSendIt implementation:
 *   http://mxr.mozilla.org/comm-central/source/mail/components/cloudfile/nsYouSendIt.js
 *
 * Edited by Szabolcs Gyuris (szimszon at oregpreshaz dot eu)
 */

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/gloda/log4moz.js");
Cu.import("resource:///modules/cloudFileAccounts.js");

var gServerUrl = "";
var kAuthPath = "api2/auth-token/";
var kUserInfoPath = "api2/account/info/";
var kRepoPath = "api2/repos/";
var TS;

function nsSeaFile() {
  this.log = Log4Moz.getConfiguredLogger("SeaFile","DEBUG","DEBUG");
}

nsSeaFile.prototype = {
  /* nsISupports */
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIMsgCloudFileProvider]),

  classID: Components.ID("{57c44a6d-2ffd-4554-8a57-a592f8361176}"),

  get type() "SeaFile",
  get displayName() "SeaFile",
  get serviceURL() gServerUrl + " - " + this._repoName,
  get iconClass() "chrome://cloudfile-seafile/skin/seafile_16.png",
  get accountKey() this._accountKey,
  get lastError() this._lastErrorText,
  get settingsURL() "chrome://cloudfile-seafile/content/settings.xhtml",
  get managementURL() "chrome://cloudfile-seafile/content/management.xhtml",

  _accountKey: false,
  _prefBranch: null,
  _userName: "",
  _password: "",
  _loggedIn: false,
  _userInfo: null,
  _repoId: "",
  _repoName: "",
  _libraryCreate: "",
  _file : null,
  _folderName: "",
  _requestDate: null,
  _successCallback: null,
  _request: null,
  _maxFileSize : -1,
  _fileSpaceUsed : -1,
  _availableStorage : -1,
  _totalStorage : -1,
  _lastErrorStatus : 0,
  _lastErrorText : "",
  _uploadingFile : null,
  _uploader : null,
  _urlsForFiles : {},
  _uploadInfo : {},
  _uploads: [],

  /**
   * Used by our testing framework to override the URLs that this component
   * communicates to.
   */
  overrideUrls: function nsSeaFile_overrideUrls(aNumUrls, aUrls) {
    gServerUrl = aUrls[0];
  },

  /**
   * Initializes an instance of this nsIMsgCloudFileProvider for an account
   * with key aAccountKey.
   *
   * @param aAccountKey the account key to initialize this
   *                    nsIMsgCloudFileProvider with.
   */
  init: function nsSeaFile_init(aAccountKey) {
    this._accountKey = aAccountKey;
    this._prefBranch = Services.prefs.getBranch("mail.cloud_files.accounts." +
                                                aAccountKey + ".");
    this._userName = this._prefBranch.getCharPref("username");
    gServerUrl = this._prefBranch.getCharPref("baseURL");
    this._repoName = this._prefBranch.getCharPref("library");
    try {
      this._libraryCreate = this._prefBranch.getBoolPref("libraryCreate");
    }
    catch (e) {
      this._libraryCreate = false;
      this._prefBranch.setBoolPref("libraryCreate", false);
    }
    this._loggedIn = this._cachedAuthToken != "";
    this._folderName = "/apps/mozilla_thunderbird";
  },

  /**
   * Private function for retrieving or creating folder
   * on SeaFile website for uploading file.
   *
   * @param aCallback called if folder is ready.
   */
  _initFolder: function nsSeaFile__initFolder(aCallback) {
    this.log.debug('_initFolder');
    let saveFolderName = function(aFolderName) {
        this.log.debug('saveFolderName('+aFolderName+')');
        this._folderName = "/apps/mozilla_thunderbird";
        if (aCallback)
          aCallback();
    }.bind(this);

    let createThunderbirdFolder = function(aParentFolderName) {
      this._createFolder("mozilla_thunderbird", aParentFolderName,
          saveFolderName);
    }.bind(this);

    let createAppsFolder = function(aParentFolderName) {
      this._createFolder("apps", aParentFolderName, createThunderbirdFolder);
    }.bind(this);

    let findThunderbirdFolder = function(aParentFolderName) {
      this._findFolder("mozilla_thunderbird", aParentFolderName,
                       createThunderbirdFolder, saveFolderName);
    }.bind(this);

    let findAppsFolder = function() {
      this._findFolder("apps", "", createAppsFolder, findThunderbirdFolder);
    }.bind(this);

    findAppsFolder();
  },

  /**
   * Private callback function passed to, and called from
   * nsSeaFileFileUploader.
   *
   * @param aRequestObserver a request observer for monitoring the start and
   *                         stop states of a request.
   * @param aStatus the status of the request.
   */
  _uploaderCallback: function nsSeaFile__uploaderCallback(aRequestObserver,
                                                            aStatus) {
    aRequestObserver.onStopRequest(null, null, aStatus);
    this.log.debug('_uploaderCallback(...,'+aStatus+')');
    this._uploadingFile = null;
    this._uploads.shift();
    if (this._uploads.length > 0) {
      let nextUpload = this._uploads[0];
      this.log.info("_uploaderCallback: chaining upload, file = " + nextUpload.file.leafName);
      this._uploadingFile = nextUpload.file;
      this._uploader = nextUpload;
      try {
        this.uploadFile(nextUpload.file, nextUpload.requestObserver);
      }
      catch (ex) {
        // I'd like to pass ex.result, but that doesn't seem to be defined.
        nextUpload.callback(nextUpload.requestObserver, Cr.NS_ERROR_FAILURE);
      }
    }
    else
      this._uploader = null;
  },

  /**
   * Attempt to upload a file to SeaFile's servers.
   *
   * @param aFile an nsILocalFile for uploading.
   * @param aCallback an nsIRequestObserver for monitoring the start and
   *                  stop states of the upload procedure.
   */
  uploadFile: function nsSeaFile_uploadFile( aFile, aCallback) {
    TS = Date.now();
    if (Services.io.offline)
      throw Ci.nsIMsgCloudFileProvider.offlineErr;

    this.log.debug("uploadFile("+this._folderName+","+aFile.leafName+"):Preparing to upload a file");

    // if we're uploading a file, queue this request.
    if (this._uploadingFile && this._uploadingFile != aFile) {
      this.log.info("Adding file ["+this._folderName+"/"+aFile.leafName+"] to queue");
      let uploader = new nsSeaFileFileUploader(this,
                                                 this._folderName,
                                                 aFile,
                                                 this._uploaderCallback
                                                     .bind(this),
                                                 aCallback);
      this._uploads.push(uploader);
      return;
    }

    this._uploadingFile = aFile;
    this._urlListener = aCallback;

    let finish = function() {
      this.log.debug("Call _finishUpload("+this._folderName+","+aFile.leafName+")");
      this._finishUpload(this._folderName,aFile, aCallback);
    }.bind(this);

    let onGetUserInfoSuccess = function() {
      this._initFolder(finish);
    }.bind(this);

    let onAuthFailure = function() {
      this._urlListener.onStopRequest(null, null,
                                      Ci.nsIMsgCloudFileProvider.authErr);
    }.bind(this);

    this.log.debug("Checking to see if we're logged in");

    if (!this._loggedIn) {
      let onLoginSuccess = function() {
        this._getUserInfo(onGetUserInfoSuccess, onAuthFailure);
      }.bind(this);

      return this.logon(onLoginSuccess, onAuthFailure, true);
    }

    if (!this._userInfo)
      return this._getUserInfo(onGetUserInfoSuccess, onAuthFailure);

    onGetUserInfoSuccess();
  },

  /**
   * A private function called when we're almost ready to kick off the upload
   * for a file. First, ensures that the file size is not too large, and that
   * we won't exceed our storage quota, and then kicks off the upload.
   *
   * @param aFile the nsILocalFile to upload
   * @param aCallback the nsIRequestObserver for monitoring the start and stop
   *                  states of the upload procedure.
   */
  _finishUpload: function nsSeaFile__finishUpload(aFolderName,aFile, aCallback) {
  this.log.debug("_finishUpload("+aFolderName+"/"+aFile.leafName+")");
    /**if (aFile.fileSize > 2147483648)
      return this._fileExceedsLimit(aCallback, '2GB', 0);
    if (aFile.fileSize > this._maxFileSize)
      return this._fileExceedsLimit(aCallback, 'Limit', 0);
    if (aFile.fileSize > this._availableStorage)
      return this._fileExceedsLimit(aCallback, 'Quota',
                                    aFile.fileSize + this._fileSpaceUsed);
    */
    delete this._userInfo; // force us to update userInfo on every upload.

    if (!this._uploader) {
      this.log.debug("_finishUpload: add uploader");
      this._uploader = new nsSeaFileFileUploader(this,
                                                 aFolderName,
                                                 aFile,
                                                   this._uploaderCallback
                                                       .bind(this),
                                                   aCallback);
      this._uploads.unshift(this._uploader);
    }

    this._uploadingFile = aFile;
    this.log.debug("_finishUpload: startUpload()");
    this._uploader.startUpload();
  },

  /**
   * A private function called when upload exceeds file limit.
   *
   * @param aCallback the nsIRequestObserver for monitoring the start and stop
   *                  states of the upload procedure.
   */
  _fileExceedsLimit: function nsSeaFile__fileExceedsLimit(aCallback, aType, aStorageSize) {
    let cancel = Ci.nsIMsgCloudFileProvider.uploadCanceled;

    let args = {storage: aStorageSize};
    args.wrappedJSObject = args;
    //FIXME: megjavítani
    Services.ww.openWindow(null,
                           "chrome://messenger/content/cloudfile/SeaFile/"
                           + "fileExceeds" + aType + ".xul",
                           "SeaFile", "chrome,centerscreen,dialog,modal,resizable=yes",
                           args).focus();

    return aCallback.onStopRequest(null, null, cancel);
  },

  /**
   * Cancels an in-progress file upload.
   *
   * @param aFile the nsILocalFile being uploaded.
   */
  cancelFileUpload: function nsSeaFile_cancelFileUpload(aFile) {
    this.log.info("cancelFileUpload("+aFile.leafName+"): in cancel upload");
    if (this._uploadingFile != null && this._uploader != null &&
        this._uploadingFile.equals(aFile)) {
      this._uploader.cancel();
    }
    else {
      for (let i = 0; i < this._uploads.length; i++)
        if (this._uploads[i].file.equals(aFile)) {
          this._uploads[i].requestObserver.onStopRequest(
            null, null, Ci.nsIMsgCloudFileProvider.uploadCanceled);
          this._uploads.splice(i, 1);
          return;
        }
    }
  },

  /**
   * A private function for dealing with stale tokens.  Attempts to refresh
   * the token without prompting for the password.
   *
   * @param aSuccessCallback called if token refresh is successful.
   * @param aFailureCallback called if token refresh fails.
   */
  _handleStaleToken: function nsSeaFile__handleStaleToken(aSuccessCallback,
                                                            aFailureCallback) {
    this.log.debug("_handleStaleToken: Handling a stale token.");
    this._loggedIn = false;
    this._cachedAuthToken = "";
    if (this.getPassword(this._userName, true) != "") {
      this.log.debug("_handleStaleToken: Attempting to reauth with saved password");
      // We had a stored password - let's try logging in with that now.
      this.logon(aSuccessCallback, aFailureCallback,
                 false);
    } else {
      this.log.debug("_handleStaleToken: No saved password stored, so we can't refresh the token silently.");
      aFailureCallback();
    }
  },

  /**
   * A private function for retreiving the selected repo-id
   */
  _createRepo: function nsSeafile_createRepo(repoName,successCallback,failureCallback) {
    this.log.debug("_createRepo("+repoName+")");
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                  .createInstance(Ci.nsIXMLHttpRequest);
    req.open("POST", gServerUrl + kRepoPath, false);

    req.onload = function() {
        let docResponse = JSON.parse(req.responseText);
        this.log.debug("_createRepo: create library response parsed = " + docResponse);
        if (req.status >= 200 && req.status < 400) {
          this.log.debug("_createRepo: request status = " + req.status +
                        " response = " + req.responseText);
          if ( docResponse.repo_name != repoName || docResponse.repo_id == "") {
                  let errormsg="_createRepo: Can't create library. Expected name: ["+repoName+"], got: ["+docResponse.repo_name+"], ["+docResponse.repo_id+"]";
                  this.log.error(errormsg);
                  this._lastErrorText=errormsg;
                  if (failureCallback){
                    failureCallback();
                  }
          }
          else
          {
            this.log.debug("_createRepo: library created: ["+docResponse.repo_name+"]["+docResponse.repo_id+"]");
            this._repoId=docResponse.repo_id;
          }
        }
        else
        {
          this.log.debug("_createRepo: error status = " + req.status);

          if (docResponse.detail=="Invalid token") {
            // Our token has gone stale
            this.log.debug("_createRepo: Our token has gone stale - requesting a new one.");

            let retryCreateRepo = function() {
              this._createRepo(successCallback, failureCallback);
            }.bind(this);

            this._handleStaleToken(retryCreateRepo, failureCallback);
            return;
          }
            if (failureCallback){
              failureCallback();
            }
        }
      }.bind(this);

      req.onerror = function() {
        this.log.error("_createRepo: create library failed - status = " + req.status);
        if (failureCallback){
              failureCallback();
            }
      }.bind(this);
      // Add a space at the end because http logging looks for two
      // spaces in the X-Auth-Token header to avoid putting passwords
      // in the log, and crashes if there aren't two spaces.
      req.setRequestHeader("Authorization", "Token "+this._cachedAuthToken + " ");
      req.setRequestHeader("Accept", "application/json");
      req.setRequestHeader("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");
      let repoDesc="Thunderbird Filelink";
      req.send("name="+repoName+"&desc="+repoDesc);
  },

  /**
   * A private function for retreiving the selected repo-id
   */
  _getRepoId: function nsSeafile_getRepoId(successCallback,failureCallback) {
    this.log.debug("_getRepoId: library id now: ["+this._repoId+"]");
    if (this._repoId!="") return ;
    this.log.debug("_getRepoId: getting library id");

      let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                  .createInstance(Ci.nsIXMLHttpRequest);
      req.open("GET", gServerUrl + kRepoPath, false);

      req.onload = function() {
        let docResponse = JSON.parse(req.responseText);
        this.log.debug("_getRepoId: library list response parsed = " + docResponse);
        if (req.status >= 200 && req.status < 400) {
          this.log.debug("_getRepoId: request status = " + req.status +
                        " response = " + req.responseText);
          for (x in docResponse) {
            if ( docResponse[x].name == this._repoName ) {
              this._repoId = docResponse[x].id;
              this.log.debug("_getRepoId: library id: ["+this._repoId+"]");
              break;
            }
          }
          if ( this._repoId == "" && this._libraryCreate ) {
            this._createRepo(this._repoName,successCallback,failureCallback);
          }
          if ( this._repoId == "" ){
                  let errormsg="_getRepoId: Can't find repository: "+this._repoName;
                  this.log.error(errormsg);
                  this._lastErrorText=errormsg;
                  if (failureCallback){
                    failureCallback();
                  }
          }
        }
        else
        {
          this.log.debug("_getRepoId: error status = " + req.status);

          if (docResponse.detail=="Invalid token") {
            // Our token has gone stale
            this.log.debug("_getRepoId: Our token has gone stale - requesting a new one.");

            let retryGetRepoId = function() {
              this._getRepoId(successCallback, failureCallback);
            }.bind(this);

            this._handleStaleToken(retryGetRepoId, failureCallback);
            return;
          }
            if (failureCallback){
              failureCallback();
            }
        }
      }.bind(this);

      req.onerror = function() {
        this.log.error("_getRepoId: library info failed - status = " + req.status);
        if (failureCallback){
              failureCallback();
            }
      }.bind(this);
      // Add a space at the end because http logging looks for two
      // spaces in the X-Auth-Token header to avoid putting passwords
      // in the log, and crashes if there aren't two spaces.
      req.setRequestHeader("Authorization", "Token "+this._cachedAuthToken + " ");
      req.setRequestHeader("Accept", "application/json");
      req.send();
  },

  /**
   * A private function for retrieving profile information about a user.
   *
   * @param successCallback a callback fired if retrieving profile information
   *                        is successful.
   * @param failureCallback a callback fired if retrieving profile information
   *                        fails.
   */
  _getUserInfo: function nsSeaFile_userInfo(successCallback, failureCallback) {
    this._getRepoId();
    if ( this._repoId == "" ) {
      failureCallback();
      return;
    }
    this.log.debug("_getUserInfo: getting user info");

    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    req.open("GET", gServerUrl + kUserInfoPath, true);

    req.onload = function() {
      if (req.status >= 200 && req.status < 400) {
        this.log.debug("_getUserInfo: request status = " + req.status +
                      " response = " + req.responseText);
        let docResponse = JSON.parse(req.responseText);
        this.log.debug("_getUserInfo: user info response parsed = " + docResponse);
        this._userInfo = docResponse;
        let account = docResponse.email;
        this._fileSpaceUsed = docResponse.usage;
        if ( docResponse.total < 0 ) {
          this._availableStorage = -1;
        }
        else this._availableStorage = docResponse.total;
        this.log.debug("_getUserInfo: available storage = " + this._availableStorage);
        successCallback();
      }
      else
      {
        this.log.debug("_getUserInfo: error status = " + req.status);

        if (docResponse.detail=="Invalid token") {
          // Our token has gone stale
          this.log.error("_getUserInfo: Our token has gone stale - requesting a new one.");

          let retryGetUserInfo = function() {
            this._getUserInfo(successCallback, failureCallback);
          }.bind(this);

          this._handleStaleToken(retryGetUserInfo, failureCallback);
          return;
        }

          failureCallback();
          return;
        }
    }.bind(this);

    req.onerror = function() {
      this.log.error("_getUserInfo: getUserInfo failed - status = " + req.status);
      failureCallback();
    }.bind(this);
    // Add a space at the end because http logging looks for two
    // spaces in the X-Auth-Token header to avoid putting passwords
    // in the log, and crashes if there aren't two spaces.
    req.setRequestHeader("Authorization", "Token "+this._cachedAuthToken + " ");
    req.setRequestHeader("Accept", "application/json");
    req.send();
  },

  /**
   * Returns the sharing URL for some uploaded file.
   *
   * @param aFile the nsILocalFile to get the URL for.
   */
  urlForFile: function nsSeaFile_urlForFile(aFile) {
    return this._urlsForFiles[aFile.path];
  },

  /**
   * Attempts to refresh cached profile information for the account associated
   * with this instance's account key.
   *
   * @param aWithUI a boolean for whether or not we should prompt the user for
   *                a password if we don't have a proper token.
   * @param aListener an nsIRequestObserver for monitoring the start and stop
   *                  states of fetching profile information.
   */
  refreshUserInfo: function nsSeaFile_refreshUserInfo(aWithUI, aListener) {
    if (Services.io.offline)
      throw Ci.nsIMsgCloudFileProvider.offlineErr;

    aListener.onStartRequest(null, null);

    // Let's define some reusable callback functions...
    let onGetUserInfoSuccess = function() {
      aListener.onStopRequest(null, null, Cr.NS_OK);
    }

    let onAuthFailure = function() {
      aListener.onStopRequest(null, null,
                              Ci.nsIMsgCloudFileProvider.authErr);
    }

    // If we're not logged in, attempt to login, and then attempt to
    // get user info if logging in is successful.
    this.log.debug("refreshUserInfo: Checking to see if we're logged in");
    if (!this._loggedIn) {
      let onLoginSuccess = function() {
        this._getUserInfo(onGetUserInfoSuccess, onAuthFailure);
      }.bind(this);

      return this.logon(onLoginSuccess, onAuthFailure, aWithUI);
    }

    // If we're logged in, attempt to get user info.
    if (!this._userInfo)
      return this._getUserInfo(onGetUserInfoSuccess, onAuthFailure);

  },

  /**
   * Creates an account for a user.  Note that, currently, this function is
   * not being used by the UI.
   */
  createNewAccount: function nsSeaFile_createNewAccount(aEmailAddress, aPassword,
                                                          aFirstName, aLastName,
                                                          aRequestObserver) {
    throw Cr.NS_ERROR_NOT_IMPLEMENTED
  },
    /**if (Services.io.offline)
      throw Ci.nsIMsgCloudFileProvider.offlineErr;

    let args = "?email=" + aEmailAddress + "&password=" + aPassword + "&firstname="
               + aFirstName + "&lastname=" + aLastName + "&";

    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);

    req.open("POST", gServerUrl + kUserInfoPath + args + kUrlTail, true);

    req.onload = function() {
      if (req.status >= 200 &&
          req.status < 400) {
        this.log.debug("request status = " + req + " response = " +
                      req.responseText);
        aRequestObserver.onStopRequest(null, null, Cr.NS_OK);
      }
      else {
        let docResponse = JSON.parse(req.responseText);
        this._lastErrorText = docResponse.errorStatus.message;
        this._lastErrorStatus = docResponse.errorStatus.code;
        aRequestObserver.onStopRequest(null, null, Cr.NS_ERROR_FAILURE);
      }
    }.bind(this);

    req.onerror = function() {
      this.log.debug("getUserInfo failed - status = " + req.status);
      aRequestObserver.onStopRequest(null, null, Cr.NS_ERROR_FAILURE);
    }.bind(this);
    // Add a space at the end because http logging looks for two
    // spaces in the X-Auth-Token header to avoid putting passwords
    // in the log, and crashes if there aren't two spaces.
    req.setRequestHeader("X-Auth-Token", this._cachedAuthToken + " ");
    req.setRequestHeader("X-Api-Key", kApiKey);
    req.setRequestHeader("Accept", "application/json");
    req.send();
  },
  */
  /**
   * Attempt to find folder by name on SF website.
   *
   * @param aFolderName name of folder
   * @param aParentFolderName id of folder where we are looking
   * @param aNotFoundCallback called if folder is not found
   * @param aFoundCallback called if folder is found
   */
  _findFolder: function nsSeaFile__findFolder(aFolderName,
                                                aParentFolderName,
                                                aNotFoundCallback,
                                                aFoundCallback) {

    this._getRepoId();
    let pfolder=aParentFolderName;
    if (pfolder=="") pfolder="/";
    this.log.debug("_findFolder("+aFolderName+","+aParentFolderName+")");
    if (Services.io.offline)
        throw Ci.nsIMsgCloudFileProvider.offlineErr;
    let args = "?p=" + pfolder;

    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                  .createInstance(Ci.nsIXMLHttpRequest);

    req.open("GET", gServerUrl + kRepoPath + this._repoId + "/dir/" + args, true);

    req.onload = function() {
        let docResponse = JSON.parse(req.responseText);
        let folderFound=false;
        if (req.status >= 200 && req.status < 400) {
          this.log.debug("_findFolder: request status = " + req + " response = " +
                        req.responseText);
          for ( let x in docResponse ){
            if ( docResponse[x].name == aFolderName ){
              this.log.debug("_findFolder: find folder: "+aFolderName);
              if ( docResponse[x].type != 'dir' ){
                this.log.debug("_findFolder: find folder: "+aFolderName+" not a dir");
                this._lastErrorText = aFolderName+" not a directory!";
                this._lastErrorStatus = 500;
              }
              else
              {
                folderFound=true;
                if (aFoundCallback)
                  if ( pfolder[pfolder.lenght-1]!="/") pfolder+="/";
                  aFoundCallback(pfolder+aFolderName);
              }
            }
          }
          if (folderFound==false && aNotFoundCallback) aNotFoundCallback(aParentFolderName);
        }
        else {
          this._lastErrorText = docResponse.details;
          this._lastErrorStatus = req.status;
          this.log.debug("_findFolder: error: "+this._lastErrorText+
                         ", "+this.lastErrorStatus);
        }
    }.bind(this);

    req.onerror = function() {
        this.log.debug("_findFolder: findFolder failed - status = " + req.status);
    }.bind(this);
      // Add a space at the end because http logging looks for two
      // spaces in the X-Auth-Token header to avoid putting passwords
      // in the log, and crashes if there aren't two spaces.
    req.setRequestHeader("Authorization", "Token "+this._cachedAuthToken + " ");
    req.setRequestHeader("Accept", "application/json");
    req.send();

  },


  /**
   * Private function for creating folder on SF website.
   *
   * @param aName name of folder
   * @param aParent id of parent folder
   * @param aSuccessCallback called when folder is created
   */
  _createFolder: function nsSeaFile__createFolder(aName,
                                                    aParent,
                                                    aSuccessCallback) {
    this.log.debug("_createFolder("+aName+","+aParent+")");
    if (aParent[aParent.lenght-1]!="/") aParent+="/";

    if (Services.io.offline)
      throw Ci.nsIMsgCloudFileProvider.offlineErr;

    this._getRepoId();
    let args = "?p=" + aParent+aName;

    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);

    req.open("POST",  gServerUrl + kRepoPath + this._repoId + "/dir/" + args, true);

    req.onload = function() {
      let docResponse = req.responseText
      if (req.status >= 200 && req.status < 400) {
        this.log.debug("_createFolder: request status = " + req + " response = " +
                      req.responseText);

        if (aSuccessCallback)
          aSuccessCallback(aParent+aName)
      }
      else {
        this._lastErrorText = docResponse;
        this._lastErrorStatus = req.status;
      }
    }.bind(this);

    req.onerror = function() {
      this.log.debug("_createFolder: createFolder failed - status = " + req.status);
    }.bind(this);
    // Add a space at the end because http logging looks for two
    // spaces in the X-Auth-Token header to avoid putting passwords
    // in the log, and crashes if there aren't two spaces.
    req.setRequestHeader("Authorization", "Token "+this._cachedAuthToken + " ");
    req.setRequestHeader("Accept", "application/json");
    req.setRequestHeader("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");
    req.send("operation=mkdir");
  },

  /**
   * If a the user associated with this account key already has an account,
   * allows them to log in.
   *
   * @param aRequestObserver an nsIRequestObserver for monitoring the start and
   *                         stop states of the login procedure.
   */
  createExistingAccount: function nsSeaFile_createExistingAccount(aRequestObserver) {
     // XXX: replace this with a better function
    let successCb = function(aResponseText, aRequest) {
      aRequestObserver.onStopRequest(null, this, Cr.NS_OK);
    }.bind(this);

    let failureCb = function(aResponseText, aRequest) {
      aRequestObserver.onStopRequest(null, this,
                                     Ci.nsIMsgCloudFileProvider.authErr);
    }.bind(this);

    this.logon(successCb, failureCb, true);
  },

  /**
   * Returns an appropriate provider-specific URL for dealing with a particular
   * error type.
   *
   * @param aError an error to get the URL for.
   */
  providerUrlForError: function nsSeaFile_providerUrlForError(aError) {
    return gServerUrl+"help";
  },

  /**
   * If the provider doesn't have an API for creating an account, perhaps
   * there's a url we can load in a content tab that will allow the user
   * to create an account.
   */
  get createNewAccountUrl() gServerUrl,

  /**
   * If we don't know the limit, this will return -1.
   */
  get fileUploadSizeLimit() this._maxFileSize,

  get remainingFileSpace() (this._availableStorage-this._fileSpaceUsed),

  get fileSpaceUsed() this._fileSpaceUsed,

  /**
   * Attempts to delete an uploaded file.
   *
   * @param aFile the nsILocalFile to delete.
   * @param aCallback an nsIRequestObserver for monitoring the start and stop
   *                  states of the delete procedure.
   */
  deleteFile: function nsSeaFile_deleteFile(aFile, aCallback) {
    this.log.debug("deleteFile("+aFile.leafName+"): Deleting a file");

    if (Services.io.offline) {
      this.log.error("We're offline - we can't delete the file.");
      throw Ci.nsIMsgCloudFileProvider.offlineErr;
    }

    let uploadInfo = this._uploadInfo[aFile.path];
    if (!uploadInfo) {
      this.log.error("deleteFile: Could not find a record for the file ["+aFile.leafName+"] to be deleted.");
      throw Cr.NS_ERROR_FAILURE;
    }

    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    this._getRepoId();
    let args = kRepoPath + this._repoId + "/file/?p="+this._folderName+"/"+
               aFile.leafName;

    req.open("DELETE", gServerUrl + args, true);
    this.log.debug("deleteFile: Sending delete request to: " + gServerUrl + args);

    req.onerror = function() {
      let response = JSON.parse(req.responseText);
      this._lastErrorStatus = req.status;
      this._lastErrorText = response.detail;
      this.log.error("deleteFile: There was a problem deleting a file ["+aFile.leafName+"]: " + this._lastErrorText);
      aCallback.onStopRequest(null, null, Cr.NS_ERROR_FAILURE);
    }.bind(this);

    req.onload = function() {
      // Response is the URL.
      let response = req.responseText;
      this.log.debug("deleteFile: delete response = " + response);
      let deleteInfo = JSON.parse(response);

      if ( req.status >= 200 && req.status < 400 ) {
        this.log.debug("deleteFile: Delete was successful! ["+aFile.leafName+"]");
        // Success!
        aCallback.onStopRequest(null, null, Cr.NS_OK);
      }
      else
      {
        this.log.error("deleteFile: Server has returned a failure on our delete request.");
        this.log.error("deleteFile: Error code: " + req.status);
        this.log.error("deleteFile: Error message: " + deleteInfo.detail);
        //aCallback.onStopRequest(null, null,
        //                        Ci.nsIMsgCloudFileProvider.uploadErr);
        return;
      }

    }.bind(this);
    req.setRequestHeader("Authorization", "Token "+this._cachedAuthToken + " ");
    req.setRequestHeader("Accept", "application/json");
    req.send();
  },

  /**
   * Returns the saved password for this account if one exists, or prompts
   * the user for a password. Returns the empty string on failure.
   *
   * @param aUsername the username associated with the account / password.
   * @param aNoPrompt a boolean for whether or not we should suppress
   *                  the password prompt if no password exists.  If so,
   *                  returns the empty string if no password exists.
   */
  getPassword: function nsSeaFile_getPassword(aUsername, aNoPrompt) {
    this.log.debug("getPassword("+aUsername+"): Getting password for user");

    if (aNoPrompt)
      this.log.debug("getPassword: Suppressing password prompt");

    let passwordURI = gServerUrl;
    let logins = Services.logins.findLogins({}, passwordURI, null, passwordURI);
    for each (let loginInfo in logins) {
      if (loginInfo.username == aUsername)
        return loginInfo.password;
    }
    if (aNoPrompt)
      return "";

    // OK, let's prompt for it.
    let win = Services.wm.getMostRecentWindow(null);

    let authPrompter = Services.ww.getNewAuthPrompter(win);
    let password = { value: "" };
    // Use the service name in the prompt text
    let serverUrl = gServerUrl;
    let userPos = gServerUrl.indexOf("//") + 2;
    let userNamePart = encodeURIComponent(this._userName) + '@';
    serverUrl = gServerUrl.substr(0, userPos) + userNamePart + gServerUrl.substr(userPos);
    let messengerBundle = Services.strings.createBundle(
      "chrome://messenger/locale/messenger.properties");
    let promptString = messengerBundle.formatStringFromName("passwordPrompt",
                                                            [this._userName,
                                                             this.displayName],
                                                            2);

    if (authPrompter.promptPassword(this.displayName, promptString, serverUrl,
                                    authPrompter.SAVE_PASSWORD_PERMANENTLY,
                                    password))
      return password.value;

    return "";
  },

  /**
   * Clears any saved SeaFile passwords for this instance's account.
   */
  clearPassword: function nsSeaFile_clearPassword() {
    let logins = Services.logins.findLogins({}, gServerUrl, null, gServerUrl);
    for each (let loginInfo in logins)
      if (loginInfo.username == this._userName)
        Services.logins.removeLogin(loginInfo);
  },

  /**
   * Attempt to log on and get the auth token for this SeaFile account.
   *
   * @param successCallback the callback to be fired if logging on is successful
   * @param failureCallback the callback to be fired if loggong on fails
   * @aparam aWithUI a boolean for whether or not we should prompt for a password
   *                 if no auth token is currently stored.
   */
  logon: function nsSeaFile_login(successCallback, failureCallback, aWithUI) {
    this.log.debug("logon: Logging in, aWithUI = " + aWithUI);
    if (this._password == undefined || !this._password)
      this._password = this.getPassword(this._userName, !aWithUI);
    this.log.debug("logon: Sending login information...");
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
    let curDate = Date.now().toString();

    req.open("POST", gServerUrl + kAuthPath, true);
    req.onerror = function() {
      this.log.debug("logon: logon failure");
      failureCallback();
    }.bind(this);

    req.onload = function() {
      if (req.status >= 200 && req.status < 400) {
        this.log.debug("logon: auth token response = " + req.responseText);
        let docResponse = JSON.parse(req.responseText);
        this.log.debug("logon: login response parsed = " + docResponse);
        this._cachedAuthToken = docResponse.token;
        this.log.debug("logon: authToken = " + this._cachedAuthToken);
        if (this._cachedAuthToken) {
          this._loggedIn = true;
          this._getRepoId();
          if ( this._repoId == "" ) {
            this.clearPassword();
            this._loggedIn = false;
            this._lastErrorText = this._repoName+" library not found.";
            this._lastErrorStatus = req.status;
            this.log.error("logon: error - "+this._lastErrorText+", "+
                          this._lastErrorStatus);
            failureCallback();
          }
          else
          {
             successCallback();
          }
        }
        else {
          this.clearPassword();
          this._loggedIn = false;
          this._lastErrorText = docResponse.detail;
          this._lastErrorStatus = req.status;
          this.log.error("logon: error - "+this._lastErrorText+", "+
              this._lastErrorStatus);
          failureCallback();
        }
      }
      else {
        this.clearPassword();
        failureCallback();
      }
    }.bind(this);
    req.setRequestHeader("Accept", "application/json");
    req.setRequestHeader("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");
    req.send("username="+encodeURIComponent(this._userName)+"&password="+encodeURIComponent(this._password));
    this.log.debug("Login information sent!");
  },

  get _cachedAuthToken() {
    let authToken = cloudFileAccounts.getSecretValue(this.accountKey,
                                                     cloudFileAccounts.kTokenRealm);

    if (!authToken)
      return "";

    return authToken;
  },

  set _cachedAuthToken(aVal) {
    if (!aVal)
      aVal = "";

    cloudFileAccounts.setSecretValue(this.accountKey,
                                     cloudFileAccounts.kTokenRealm,
                                     aVal);
  },
};

function nsSeaFileFileUploader(aSeaFile, aFolderName, aFile, aCallback,
                                 aRequestObserver) {
  this.seaFile = aSeaFile;
  this.log = this.seaFile.log;
  this._repoId = this.seaFile._repoId;
  this.folderName = aFolderName;
  this._cachedAuthToken = this.seaFile._cachedAuthToken;
  this.log.debug("nsSeaFileFileUploader(" +this.folderName + "," + aFile.leafName + ")");
  this.file = aFile;
  this.callback = aCallback;
  this.requestObserver = aRequestObserver;
}

nsSeaFileFileUploader.prototype = {
  seaFile : null,
  file : null,
  folderName : null,
  callback : null,
  _request : null,

  /**
   * Kicks off the upload procedure for this uploader.
   */
  startUpload: function nsSFU_startUpload() {
  this.log.debug('startUpload('+this.folderName+','+this.file.leafName+')');
    let curDate = Date.now().toString();

    this.requestObserver.onStartRequest(null, null);

    let onSuccess = function() {
      this._uploadFile();
    }.bind(this);

    let onFailure = function() {
      this.callback(this.requestObserver, Ci.nsIMsgCloudFileProvider.uploadErr);
    }.bind(this);

    return this._prepareToSend(onSuccess, onFailure);
  },

  /**
   * Communicates with SeaFile to get the URL that we will send the upload
   * request to.
   *
   * @param successCallback the callback fired if getting the URL is successful
   * @param failureCallback the callback fired if getting the URL fails
   */
  _prepareToSend: function nsSFU__prepareToSend(successCallback,
                                                  failureCallback) {
  this.log.debug("_prepareToSend");
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);

    req.open("GET", gServerUrl + kRepoPath + this._repoId+"/upload-link/", true);

    req.onerror = failureCallback;

    req.onload = function() {
      let response = req.responseText;
      if (req.status >= 200 && req.status < 400) {
        this._urlInfo = JSON.parse(response);
        this.seaFile._uploadInfo[this.file.path] = this._urlInfo;
        this.log.debug("_prepareToSend: in prepare to send response = " + response);
        this.log.debug("_prepareToSend: upload url = " + this._urlInfo);
        successCallback();
      }
      else {
        this.log.error("_prepareToSend: Preparing to send failed!");
        this.log.error("_prepareToSend: Response was: " + response);
        this.seaFile._lastErrorText = req.responseText;
        this.seaFile._lastErrorStatus = req.status;
        failureCallback();
      }
    }.bind(this);

    // Add a space at the end because http logging looks for two
    // spaces in the X-Auth-Token header to avoid putting passwords
    // in the log, and crashes if there aren't two spaces.
    req.setRequestHeader("Authorization", "Token "+this._cachedAuthToken + " ");
    req.setRequestHeader("Accept", "application/json");
    req.send();
  },

  /**
   * Once we've got the URL to upload the file to, this function actually does
   * the upload of the file to SeaFile.
   */
  _uploadFile: function nsSFU__uploadFile() {
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);

    this.log.debug("_uploadFile: "+this.file.leafName);
    let curDate = Date.now().toString();
    this.log.debug("_uploadFile("+this.file.leafName+"): ("+this.folderName+") upload url = " + this._urlInfo);
    this.request = req;
    req.open("POST", this._urlInfo, true);
    req.onload = function() {
      this.cleanupTempFile();
      if (req.status >= 200 && req.status < 400) {
        try {
          this.log.debug("_uploadFile("+this.file.leafName+"): upload response = " + req.responseText);
          this._getSharedLink();
        } catch (ex) {
          this.log.error(ex);
        }
      }
      else
      {
      this.log.error("_uploadFile("+this.file.leafName+"): error - "+req.responseText);
        this.callback(this.requestObserver,
                      Ci.nsIMsgCloudFileProvider.uploadErr);
      }
    }.bind(this);

    req.onerror = function () {
      this.cleanupTempFile();
      if (this.callback)
        this.callback(this.requestObserver,
                      Ci.nsIMsgCloudFileProvider.uploadErr);
    }.bind(this);

    req.setRequestHeader("Date", curDate);
    req.setRequestHeader("Authorization", "Token "+this._cachedAuthToken + " ");
    let boundary = "------" + curDate;
    let contentType = "multipart/form-data; boundary="+ boundary;
    req.setRequestHeader("Content-Type", contentType+"; charset=utf-8");

    //let fileName = /^[\040-\176]+$/.test(this.file.leafName)
    //    ? this.file.leafName
    //    : encodeURIComponent(this.file.leafName);
    let fileName = TS+'_'+this.file.leafName;
    let fileContents = "--" + boundary +
      "\r\nContent-Disposition: form-data; name=\"parent_dir\"\r\n\r\n"+
      this.folderName+"\r\n"+
      "--"+boundary+
      '\r\nContent-Disposition: form-data; name="file"; filename="'+
      unescape(encodeURIComponent(fileName))+'"\r\n'+
      "Content-Type: application/octet-stream" +
      "\r\n\r\n";

    // Since js doesn't like binary data in strings, we're going to create
    // a temp file consisting of the message preamble, the file contents, and
    // the post script, and pass a stream based on that file to
    // nsIXMLHttpRequest.send().

    try {
      this._tempFile = this.getTempFile(this.file.leafName);
      let ostream = Cc["@mozilla.org/network/file-output-stream;1"]
                     .createInstance(Ci.nsIFileOutputStream);
      ostream.init(this._tempFile, -1, -1, 0);
      ostream.write(fileContents, fileContents.length);

      this._fstream = Cc["@mozilla.org/network/file-input-stream;1"]
                       .createInstance(Ci.nsIFileInputStream);
      let sstream = Cc["@mozilla.org/scriptableinputstream;1"]
                       .createInstance(Ci.nsIScriptableInputStream);
      this._fstream.init(this.file, -1, 0, 0);
      sstream.init(this._fstream);

      // This blocks the UI which is less than ideal. But it's a local
      // file operations so probably not the end of the world.
      while (sstream.available() > 0) {
        let bytes = sstream.readBytes(sstream.available());
        ostream.write(bytes, bytes.length);
      }

      fileContents = "\r\n--" + boundary + "--\r\n";
      ostream.write(fileContents, fileContents.length);

      ostream.close();
      this._fstream.close();
      sstream.close();

      // defeat fstat caching
      this._tempFile = this._tempFile.clone();
      this._fstream.init(this._tempFile, -1, 0, 0);
      this._fstream.close();
      // I don't trust re-using the old fstream.
      this._fstream = Cc["@mozilla.org/network/file-input-stream;1"]
                     .createInstance(Ci.nsIFileInputStream);
      this._fstream.init(this._tempFile, -1, 0, 0);
      this._bufStream = Cc["@mozilla.org/network/buffered-input-stream;1"]
                        .createInstance(Ci.nsIBufferedInputStream);
      this._bufStream.init(this._fstream, 4096);
      // nsIXMLHttpRequest's nsIVariant handling requires that we QI
      // to nsIInputStream.
      req.send(this._bufStream.QueryInterface(Ci.nsIInputStream));
    } catch (ex) {
      this.cleanupTempFile();
      this.log.error(ex);
      throw ex;
    }
  },

  /**
   * Cancels the upload request for the file associated with this Uploader.
   */
  cancel: function nsSFU_cancel() {
    this.log.debug("cancel("+this.file.leafName+"): in uploader cancel");
    this.callback(this.requestObserver, Ci.nsIMsgCloudFileProvider.uploadCanceled);
    delete this.callback;
    if (this.request) {
      this.log.debug("cancel("+this.file.leafName+"): cancelling upload request");
      let req = this.request;
      if (req.channel) {
        this.log.debug("cancel("+this.file.leafName+"): cancelling upload channel");
        req.channel.cancel(Cr.NS_BINDING_ABORTED);
      }
      this.request = null;
    }
  },
  /**
   * Once the file is uploaded, if we want to get a sharing URL back, we have
   * to query it.
   */
  _getSharedLink: function nsSFU__getSharedLink() {
    this.log.debug("_getSharedLink("+this.file.leafName+"): get shared link");
    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);

    req.open("PUT", gServerUrl + kRepoPath + this._repoId+"/file/shared-link/", true);

    req.onerror = function() {
      this.log.debug("_getSharedLink("+this.file.leafName+"): error in query");
      this.callback(this.requestObserver,
                    Ci.nsIMsgCloudFileProvider.uploadErr);
    }.bind(this);

    let uploadInfo="";
    req.onload = function() {
      if (req.status >= 200 && req.status < 400) {
        let response = req.getResponseHeader('Location');
        this.log.debug("_getSharedLink("+this.file.leafName+"): commit response = " + response);
        uploadInfo = response;
      }
      let succeed = function() {
        this.log.debug("_getSharedLink("+this.file.leafName+"): signal success.");
        this.callback(this.requestObserver, Cr.NS_OK);
      }.bind(this);

      let failed = function() {
        this.callback(this.requestObserver, this.file.leafName.length > 120
                      ? Ci.nsIMsgCloudFileProvider.uploadExceedsFileNameLimit
                      : Ci.nsIMsgCloudFileProvider.uploadErr);
      }.bind(this);

      if (uploadInfo=="") {
        this.seaFile._lastErrorText = req.responseText;
        this.seaFile._lastErrorStatus = req.status;
        this.log.error("_getSharedLink("+this.file.leafName+"): error - "+this.seaFile._lastErrorText+", "+
        this.seaFile._lastErrorStatus);
        failed();
      }
      else {
        this.seaFile._urlsForFiles[this.file.path] = uploadInfo;
        succeed();
      }
    }.bind(this);

    req.setRequestHeader("Authorization", "Token "+this._cachedAuthToken + " ");
    req.setRequestHeader("Accept", "application/json");
    req.setRequestHeader("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");
    //let fileName = /^[\040-\176]+$/.test(this.file.leafName)
    //              ? this.file.leafName
    //              : encodeURIComponent(this.file.leafName);
    let fileName = this.file.leafName;
    req.send("p="+this.folderName+"/"+TS+'_'+fileName);
  },

  /**
   * Creates and returns a temporary file on the local file system.
   */
  getTempFile: function nsSFU_getTempFile(leafName) {
    let tempfile = Services.dirsvc.get("TmpD", Ci.nsIFile);
    tempfile.append(leafName)
    tempfile.createUnique(Components.interfaces.nsIFile.NORMAL_FILE_TYPE, parseInt("0666", 8));
    // do whatever you need to the created file
    return tempfile.clone()
  },

  /**
   * Cleans up any temporary files that this nsSeaFileFileUploader may have
   * created.
   */
  cleanupTempFile: function nsSFU_cleanupTempFile() {
    if (this._bufStream)
      this._bufStream.close();
    if (this._fstream)
      this._fstream.close();
    if (this._tempFile)
      this._tempFile.remove(false);
  },
};

const NSGetFactory = XPCOMUtils.generateNSGetFactory([nsSeaFile]);
