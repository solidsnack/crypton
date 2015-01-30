/* Crypton Client, Copyright 2013 SpiderOak, Inc.
 *
 * This file is part of Crypton Client.
 *
 * Crypton Client is free software: you can redistribute it and/or modify it
 * under the terms of the Affero GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version.
 *
 * Crypton Client is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the Affero GNU General Public
 * License for more details.
 *
 * You should have received a copy of the Affero GNU General Public License
 * along with Crypton Client.  If not, see <http://www.gnu.org/licenses/>.
*/

(function() {

'use strict';

var Item = crypton.Item = function Item (name, value, session, creator, callback) {
  // XXXddahl: do argument validation
  this.raw = null;
  this.name = name;
  this.session = session;
  this.creator = creator; // The peer who owns this Item
  this._value = value || null;
  this.listeners = [];
  this.sessionKey = null;

  this.sync(callback || function (err) {
    if (err) {
      // throws if there is an error
      // and no callback supplied
      console.log(err);
      throw new Error(err);
    }
  });

  var that = this;
  Object.defineProperty(this, 'value', {
    get: function () {
      return that._value;
    },
    set: function (value) {
      that._value = value;
      // that.save();
    }
  });
};

Item.prototype.getPublicName = function () {
  if (this.name) {
    return this.name;
  } else if (this.nameHmac) {
    return this.nameHmac;
  } else {
    throw new Error('Item must have a name or itemNameHmac');
  }

  var hmac = new sjcl.misc.hmac(this.session.account.containerNameHmacKey);
  var containerNameHmac = hmac.encrypt(this.name);
  this.nameHmac = sjcl.codec.hex.fromBits(containerNameHmac);
  return this.nameHmac;
};

Item.prototype.sync = function (callback) {
  var itemNameHmac = this.getPublicName();
  this.syncWithHmac(itemNameHmac, callback);
};

Item.prototype.syncWithHmac = function (itemNameHmac, callback) {
  console.log('syncWithHmac()');
  var that = this;
  var url = crypton.url() + '/item/' + itemNameHmac;

  superagent.get(url)
    .withCredentials()
    .end(function (res) {
      console.log('syncWithHmac result: ', res);

      var doesNotExist = 'Item does not exist';

      if ((!res.body || res.body.success !== true) && res.body.error != doesNotExist) {
        return callback(res.body.error);
      }

      if (res.body.error == doesNotExist) {
        console.log('does not exist, creating....');
        return that.create(callback);
      }

      // XXXddahl: alert listeners?
      that.parseAndOverwrite(res.body.value, callback);
    });
};

Item.prototype.parseAndOverwrite = function (value, callback) {
  console.log('parseAndOverwrite', value);
  // We were just handed the latest version stored on the server. overwrite locally
  var cipherItem = JSON.parse(value);

  var hash = sjcl.hash.sha256.hash(cipherItem.ciphertext);
  var verified = false;
  try {
    verified = this.creator.signKeyPub.verify(hash, cipherItem.signature);
  } catch (ex) {
    console.error(ex);
    console.error(ex.stack);
    return callback('Cannot verify Item ' + this.getPublicName());
  }

  var decrypted = sjcl.decrypt(this.secretKey, cipherItem.ciphertext, crypton.cipherOptions);

  if (decrypted.error) {
    console.error(decrypted.error);
    return callback('Cannot get and decrypt item ' + this.name);
  }

  this.value = JSON.parse(decrypted.plaintext);
  callback(null, this);
};

Item.prototype.save = function (callback) {
  console.log('saving', this.raw);
  var that = this;
  // this.raw = JSON.stringify(this.value);
  var rawPayloadCiphertext = sjcl.encrypt(that.sessionKey, this.raw, crypton.cipherOptions);
  var payloadCiphertextHash = sjcl.hash.sha256.hash(JSON.stringify(rawPayloadCiphertext));
  var payloadSignature = that.session.account.signKeyPrivate.sign(payloadCiphertextHash, crypton.paranoia);
  var payload = {
    ciphertext: rawPayloadCiphertext,
    signature: payloadSignature
  };

  var url = crypton.url() + '/item/' + this.getPublicName();
  superagent.post(url)
    .withCredentials()
    .send(payload)
    .end(function (res) {
      // XXXdddahl: error checking
      if (!res.success) {
        return callback('Cannot save item');
      }
      return callback(null);
    });
};

Item.prototype.share = function () {
  throw new Error('Unimplemented');
};

Item.prototype.unshare = function () {
  throw new Error('Unimplemented');
};

Item.prototype.watch = function (listener) {
  throw new Error('Unimplemented');
  // this.listeners.push(listener);
};

Item.prototype.unwatch = function () {
  throw new Error('Unimplemented');
};

/**!
 * ### create(itemName, callback)
 * Create item and save it to server
 *
 * Calls back with item and without error if successful
 *
 * Calls back with error if unsuccessful
 *
 * @param {Function} callback
 */
Item.prototype.create = function (callback) {
  console.log('create()');
  if (!callback) {
    throw new Error('Callback function required');
  } else {
    if (typeof callback != 'function') {
      throw new Error('Callback argument type must be function');
    }
  }

  var selfPeer = new crypton.Peer({
    session: this.session,
    pubKey: this.session.account.pubKey,
    signKeyPub: this.session.account.signKeyPub,
    signKeyPrivate: this.session.account.signKeyPrivate
  });
  selfPeer.trusted = true;

  var sessionKey = crypton.randomBytes(32);
  this.sessionKey = sessionKey;
  var sessionKeyCiphertext;

  try {
    sessionKeyCiphertext = selfPeer.encryptAndSign(sessionKey);
  } catch (ex) {
    console.log(ex);
    console.log(ex.stack);
  }
  if (sessionKeyCiphertext.error) {
    return callback(sessionKeyCiphertext.error);
  }

  delete sessionKeyCiphertext.error;

  var itemNameHmac = this.getPublicName();

  var itemValue;
  if (this._value) {
    if (typeof this._value == 'string') {
      itemValue = this._value;
    } else {
      console.log('stringifying value');
      itemValue = JSON.stringify(this._value);
    }
  } else {
    console.log('setting value to a blank object');
    itemValue = '{}';
    this._value = {};
  }
  // debugger;
  console.log('account: ', this.session.account);
  var rawPayloadCiphertext;
  try {
    rawPayloadCiphertext = sjcl.encrypt(sessionKey, itemValue, crypton.cipherOptions);
  } catch (ex) {
    console.log(ex);
    console.log(ex.stack);
  }
  // debugger;
  console.log('rawPayloadCiphertext: ', rawPayloadCiphertext);
  var payloadCiphertextHash;
  try {
    payloadCiphertextHash = sjcl.hash.sha256.hash(rawPayloadCiphertext);
  } catch (ex) {
    console.error(ex);
    console.error(ex.stack);
  }
  console.log('PayloadCiphertextHash: ', payloadCiphertextHash);
  var payloadSignature = this.session.account.signKeyPrivate.sign(payloadCiphertextHash, crypton.paranoia);

  var payloadCiphertext = {
    ciphertext: JSON.parse(rawPayloadCiphertext), // Fucking SJCL. WTF?
    signature: payloadSignature
  };

  // TODO is signing the sessionKey even necessary if we're
  // signing the sessionKeyShare? what could the container
  // creator attack by wrapping a different sessionKey?
  var sessionKeyHash;
  try {
    sessionKeyHash = sjcl.hash.sha256.hash(sessionKeyCiphertext);
  } catch (ex) {
    console.error(ex);
    console.error(ex.stack);
  }
  var sessionKeySignature =
    this.session.account.signKeyPrivate.sign(sessionKeyHash, crypton.paranoia);

  var that = this;
  // post create item
  var payload = {
    itemNameHmac: itemNameHmac,
    payloadCiphertext: JSON.stringify(payloadCiphertext),
    wrappedSessionKey: JSON.stringify(sessionKeyCiphertext)
  };
  var url = crypton.url() + '/createitem';
  superagent.post(url).withCredentials().send(payload).end(function (res) {
    // XXXddahl: better error checking & reporting needed
    console.log(res);
    if (!res.body.success) {
      callback('Cannot create item');
    }
    that.modTime = new Date(res.body.itemMetaData.modTime);
    that.session.items[that.name] = that;

    callback(null, res.body.itemMetaData);
  });
};

})();