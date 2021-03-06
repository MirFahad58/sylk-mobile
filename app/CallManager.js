import events from 'events';
import Logger from '../Logger';
import uuid from 'react-native-uuid';
import { Platform, PermissionsAndroid } from 'react-native';
import utils from './utils';

const logger = new Logger('CallManager');
import { CONSTANTS as CK_CONSTANTS } from 'react-native-callkeep';

// https://github.com/react-native-webrtc/react-native-callkeep

/*
const CONSTANTS = {
  END_CALL_REASONS: {
    FAILED: 1,
    REMOTE_ENDED: 2,
    UNANSWERED: 3,
    ANSWERED_ELSEWHERE: 4,
    DECLINED_ELSEWHERE: 5,
    MISSED: 6
  }
};
*/

const options = {
    ios: {
        appName: 'Sylk',
        maximumCallGroups: 1,
        maximumCallsPerCallGroup: 2,
        supportsVideo: true,
        includesCallsInRecents: true,
        imageName: "Image-1"
    },
    android: {
        alertTitle: 'Calling account permission',
        alertDescription: 'Please allow Sylk inside All calling accounts',
        cancelButton: 'Deny',
        okButton: 'Allow',
        imageName: 'phone_account_icon',
        additionalPermissions: [PermissionsAndroid.PERMISSIONS.CAMERA, PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, PermissionsAndroid.PERMISSIONS.READ_CONTACTS]
    }
};

export default class CallManager extends events.EventEmitter {
    constructor(RNCallKeep, acceptFunc, rejectFunc, hangupFunc, timeoutFunc, conferenceCallFunc, startCallFromCallKeeper, muteFunc, getConnectionFunct, missedCallFunc, changeRouteFunc, respawnConnection) {
        //logger.debug('constructor()');
        super();
        this.setMaxListeners(Infinity);

        this._RNCallKeep = RNCallKeep;

        this._calls = new Map();
        this._pushCalls = new Map();
        this._conferences = new Map();
        this._rejectedCalls = new Map();
        this._acceptedCalls = new Map();
        this._cancelledCalls = new Map();
        this._alertedCalls = new Map();
        this._terminatedCalls = new Map();

        this.webSocketActions = new Map();
        this.pushNotificationsActions = new Map();
        this._timeouts = new Map();

        this.sylkAcceptCall = acceptFunc;
        this.sylkRejectCall = rejectFunc;
        this.sylkHangupCall = hangupFunc;
        this.timeoutCall = timeoutFunc;
        this.logMissedCall = missedCallFunc;
        this.getConnection = getConnectionFunct;
        this.changeRoute = changeRouteFunc;
        this.respawnConnection = respawnConnection;

        this.toggleMute = muteFunc;

        this.conferenceCall = conferenceCallFunc;
        this.outgoingMedia = {audio: true, video: true}

        this.startCallFromOutside = startCallFromCallKeeper;

        this._boundRnAccept = this._rnAccept.bind(this);
        this._boundRnEnd = this._rnEnd.bind(this);
        this._boundRnMute = this._rnMute.bind(this);
        this._boundRnActiveAudioCall = this._rnActiveAudioSession.bind(this);
        this._boundRnDeactiveAudioCall = this._rnDeactiveAudioSession.bind(this);
        this._boundRnDTMF = this._rnDTMF.bind(this);
        this._boundRnProviderReset = this._rnProviderReset.bind(this);
        this.boundRnStartAction = this._startedCall.bind(this);
        this.boundRnDisplayIncomingCall = this._displayIncomingCall.bind(this);

        this._RNCallKeep.addEventListener('answerCall', this._boundRnAccept);
        this._RNCallKeep.addEventListener('endCall', this._boundRnEnd);
        this._RNCallKeep.addEventListener('didPerformSetMutedCallAction', this._boundRnMute);
        this._RNCallKeep.addEventListener('didActivateAudioSession', this._boundRnActiveAudioCall);
        this._RNCallKeep.addEventListener('didDeactivateAudioSession', this._boundRnDeactiveAudioCall.bind(this));
        this._RNCallKeep.addEventListener('didPerformDTMFAction', this._boundRnDTMF);
        this._RNCallKeep.addEventListener('didResetProvider', this._boundRnProviderReset);
        this._RNCallKeep.addEventListener('didReceiveStartCallAction', this.boundRnStartAction);
        this._RNCallKeep.addEventListener('didDisplayIncomingCall', this.boundRnDisplayIncomingCall);

        this._RNCallKeep.setup(options);

        this._RNCallKeep.addEventListener('checkReachability', () => {
            this._RNCallKeep.setReachable();
        });
    }

    get callKeep() {
        return this._RNCallKeep;
    }

    get countCalls() {
        return this._calls.size;
    }

    get countPushCalls() {
        return this._pushCalls.size;
    }

    get waitingCount() {
        return this._timeouts.size;
    }

    get callUUIDS() {
        return Array.from( this._calls.keys() );
    }

    get calls() {
        return [...this._calls.values()];
    }

    setAvailable(available) {
        this.callKeep.setAvailable(available);
    }

    heartbeat() {
        this.callUUIDS.forEach((callUUID) => {
            //utils.timestampedLog('Callkeep: call active', callUUID);
        });
    }

    backToForeground() {
       //utils.timestampedLog('Callkeep: bring app to the FOREGROUND');
       this.callKeep.backToForeground();
    }

    startOutgoingCall(callUUID, targetUri, hasVideo) {
        utils.timestampedLog('Callkeep: will start outgoing', callUUID);
        if (Platform.OS === 'ios') {
            this.callKeep.startCall(callUUID, targetUri, targetUri, 'email', hasVideo);
        } else if (Platform.OS === 'android') {
            this.callKeep.startCall(callUUID, targetUri, targetUri);
        }
    }

    updateDisplay(callUUID, displayName, uri) {
        utils.timestampedLog('Callkeep: update display', displayName, uri);
        this.callKeep.updateDisplay(callUUID, displayName, uri);
    }

    sendDTMF(callUUID, digits) {
        utils.timestampedLog('Callkeep: send DTMF: ', digits);
        this.callKeep.sendDTMF(callUUID, digits);
    }

    setCurrentCallActive(callUUID) {
        utils.timestampedLog('Callkeep: CALL ACTIVE', callUUID);
        this.callKeep.setCurrentCallActive(callUUID);
    }

    endCalls() {
        utils.timestampedLog('Callkeep: end all calls');
        this.callKeep.endAllCalls();
    }

    endCall(callUUID, reason) {
        if (reason) {
            utils.timestampedLog('Callkeep: end call', callUUID, 'with reason', reason);
        } else {
            utils.timestampedLog('Callkeep: end call', callUUID);
        }

        if (this._pushCalls.has(callUUID)) {
            this._pushCalls.delete(callUUID);
        }

        if (this._rejectedCalls.has(callUUID)) {
        //    return;
        }

        if (this._cancelledCalls.has(callUUID)) {
            //utils.timestampedLog('Callkeep: CALL', callUUID, 'already cancelled');
            return;
        }

        if (reason === 2) {
            this._cancelledCalls.set(callUUID, Date.now());
        }

        if (reason) {
            this.callKeep.reportEndCallWithUUID(callUUID, reason);
            if (this._timeouts.has(callUUID)) {
                clearTimeout(this._timeouts.get(callUUID));
                this._timeouts.delete(callUUID);
            }
        } else {
            this.callKeep.endCall(callUUID);
        }
    }

    terminateCall(callUUID) {
        if (this._calls.has(callUUID)) {
           this._calls.delete(callUUID);
        }
        this._terminatedCalls.set(callUUID, Date.now());

        if (this._pushCalls.has(callUUID)) {
            this._pushCalls.delete(callUUID);
        }
    }

    _rnActiveAudioSession() {
        utils.timestampedLog('Callkeep: activated audio call');
    }

    _rnDeactiveAudioSession() {
        utils.timestampedLog('Callkeep: deactivated audio call');
    }

    _rnAccept(data) {
        let callUUID = data.callUUID.toLowerCase();
        utils.timestampedLog('---- Callkeep: accept callback', callUUID);

        if (this._pushCalls.has(callUUID)) {
            this._pushCalls.delete(callUUID);
        }

        if (!this._rejectedCalls.has(callUUID)) {
            utils.timestampedLog('Callkeep: accept call', callUUID);
            this.acceptCall(callUUID);
        } else {
            utils.timestampedLog('Callkeep: cannot accept because we already rejected', callUUID);
            this.endCall(callUUID);
        }
    }

    _rnEnd(data) {
        // this is called both when user touches Reject and when the call ends
        let callUUID = data.callUUID.toLowerCase();
        utils.timestampedLog('Callkeep: end callback', callUUID);

        if (this._pushCalls.has(callUUID)) {
            this._pushCalls.delete(callUUID);
        }

        if (this._terminatedCalls.has(callUUID)) {
            return;
        }

        let call = this._calls.get(callUUID);

        if (!call && !this._conferences.has(callUUID)) {
            utils.timestampedLog('Callkeep: add call', callUUID, 'reject to the waitings list');
            this.webSocketActions.set(callUUID, 'reject');
            return;
        }

        if (call && call.state === 'incoming') {
            if (!this._acceptedCalls.has(callUUID)) {
                this.rejectCall(callUUID);
            }
        } else {
            if (this._conferences.has(callUUID)) {
                const conference = this._conferences.get(callUUID);
                this.logMissedCall(conference.room, callUUID, direction='received', participants=[conference.from]);
                this._conferences.delete(callUUID);
            } else {
                this.sylkHangupCall(callUUID, 'user_press_hangup');
            }
        }
    }

    acceptCall(callUUID) {
        if (this._acceptedCalls.has(callUUID)) {
            //utils.timestampedLog('Callkeep: already accepted call', callUUID);
            utils.timestampedLog('Callkeep: accept call again', callUUID);
            //return;
        } else {
            utils.timestampedLog('Callkeep: accept call', callUUID);
        }

        this.setCurrentCallActive(callUUID);

        this._acceptedCalls.set(callUUID, Date.now());

        if (this._timeouts.has(callUUID)) {
            clearTimeout(this._timeouts.get(callUUID));
            this._timeouts.delete(callUUID);
        }

        if (this._conferences.has(callUUID)) {
            let conference = this._conferences.get(callUUID);

            utils.timestampedLog('Callkeep: accept incoming conference', callUUID);

            this.endCall(callUUID, 4);
            this.backToForeground();

            utils.timestampedLog('Callkeep: will start conference to', conference.room);
            this.conferenceCall(conference.room, this.outgoingMedia);
            this._conferences.delete(callUUID);

        } else if (this._calls.has(callUUID)) {
            this.backToForeground();
            this.sylkAcceptCall(callUUID);

        } else {
            this.backToForeground();
            utils.timestampedLog('Callkeep: add call', callUUID, 'accept to the waitings list');
            // We accepted the call before it arrived on web socket
            this.respawnConnection();
            this.webSocketActions.set(callUUID, 'accept');
            utils.timestampedLog('Callkeep: check over 12 seconds if call', callUUID, 'arrived over web socket');

            setTimeout(() => {
                const connection = this.getConnection();
                if (this.callUUIDS) {
                    utils.timestampedLog('Callkeep: current calls:', this.callUUIDS);
                }

                if (!this._calls.has(callUUID) && !this._terminatedCalls.has(callUUID)) {
                    utils.timestampedLog('Callkeep: call', callUUID, 'did not arrive over web socket', connection);
                    this.webSocketActions.delete(callUUID);
                    this.endCall(callUUID, 1);
                    this.sylkHangupCall(callUUID, 'timeout');
                } else {
                    utils.timestampedLog('Callkeep: call', callUUID, 'did arrive over web socket', connection);
                }
            }, 12000);
        }
    }

    rejectCall(callUUID) {

        if (this._rejectedCalls.has(callUUID)) {
            utils.timestampedLog('Callkeep: already rejected call', callUUID);
            return;
        }

        utils.timestampedLog('Callkeep: reject call', callUUID);

        this._rejectedCalls.set(callUUID, Date.now());

        if (this._timeouts.has(callUUID)) {
            clearTimeout(this._timeouts.get(callUUID));
            this._timeouts.delete(callUUID);
        }

        this.callKeep.rejectCall(callUUID);

        if (this._conferences.has(callUUID)) {
            utils.timestampedLog('Callkeep: reject conference invite', callUUID);
            let room = this._conferences.get(callUUID);
            this._conferences.delete(callUUID);

        } else if (this._calls.has(callUUID)) {
            let call = this._calls.get(callUUID);
            if (call.state === 'incoming') {
                this.sylkRejectCall(callUUID);
            } else {
                this.sylkHangupCall(callUUID, 'user_press_hangup');
            }
        } else {
            // We rejected the call before it arrived on web socket
            // from iOS push notifications
            utils.timestampedLog('Callkeep: add call', callUUID, 'reject to the waitings list');
            this.webSocketActions.set(callUUID, 'reject');
            utils.timestampedLog('Callkeep: check over 20 seconds if call', callUUID, 'arrived on web socket');

            setTimeout(() => {
                if (!this._calls.has(callUUID)) {
                    utils.timestampedLog('Callkeep: call', callUUID, 'did not arrive on web socket');
                    this.webSocketActions.delete(callUUID);
                    this.endCall(callUUID, 1);
                }
            }, 20000);
        }

        this.endCall(callUUID);
    }

    setMutedCall(callUUID, mute=false) {
        //utils.timestampedLog('Callkeep: set call', callUUID, 'muted =', mute);

        if (this._calls.has(callUUID)) {
            this.callKeep.setMutedCall(callUUID, mute);
            let call = this._calls.get(callUUID);
            const localStream = call.getLocalStreams()[0];

            if (mute) {
                utils.timestampedLog('Callkeep: local stream audio track disabled');
            } else {
                utils.timestampedLog('Callkeep: local stream audio track enabled');
            }
            localStream.getAudioTracks()[0].enabled = !mute;
        }
    }

    _rnMute(data) {
        utils.timestampedLog('Callkeep: mute ' + data.muted + ' for call', data.callUUID);
        this.toggleMute(data.callUUID, data.muted);
    }

    _rnDTMF(data) {
        utils.timestampedLog('Callkeep: got dtmf for call', data.callUUID);
        if (this._calls.has(data.callUUID.toLowerCase())) {
            let call = this._calls.get(data.callUUID.toLowerCase());
            utils.timestampedLog('sending webrtc dtmf', data.digits)
            call.sendDtmf(data.digits);
        }
    }

    _rnProviderReset() {
        utils.timestampedLog('Callkeep: got a provider reset, clearing down all calls');
        this._calls.forEach((call) => {
            call.terminate();
        });
    }

    addWebsocketCall(call) {
        const connection = this.getConnection();
        if (this._calls.has(call.id)) {
            return;
        }
        //utils.timestampedLog('Callkeep: added call', call.id, 'for connection', connection);
        this._calls.set(call.id, call);
    }

    incomingCallFromPush(callUUID, from, displayName, force=false, skipNativePanel=false) {
        utils.timestampedLog('Callkeep: handle new incoming push call', callUUID, 'from', from);

        if (this._pushCalls.has(callUUID)) {
            utils.timestampedLog('Callkeep: push call already handled', callUUID);
            return;
        }

        this._pushCalls.set(callUUID, true);

        if (this._rejectedCalls.has(callUUID)) {
            utils.timestampedLog('Callkeep: call already rejected', callUUID);
            this.endCall(callUUID, CK_CONSTANTS.END_CALL_REASONS.UNANSWERED);
            return;
        }

        if (this._acceptedCalls.has(callUUID)) {
            utils.timestampedLog('Callkeep: call already accepted', callUUID);
            return;
        }

        // if user does not decide anything this will be handled later
        this._timeouts.set(callUUID, setTimeout(() => {
            utils.timestampedLog('Callkeep: incoming call', callUUID, 'timeout');
            let reason = this.webSocketActions.has(callUUID) ? CK_CONSTANTS.END_CALL_REASONS.FAILED : CK_CONSTANTS.END_CALL_REASONS.UNANSWERED;

            if (!this._terminatedCalls.has(callUUID) && !this._calls.has(callUUID)) {
                const connection = this.getConnection();
                utils.timestampedLog('Callkeep: call', callUUID, 'did not arive on web socket', connection);
                reason = CK_CONSTANTS.END_CALL_REASONS.FAILED;
            } else if (this._calls.has(callUUID)) {
                utils.timestampedLog('Callkeep: user did not accept or reject', callUUID);
            }
            this.endCall(callUUID, reason);
            this._timeouts.delete(callUUID);
        }, 45000));

        if (Platform.OS === 'ios') {
            if (this._calls.has(callUUID)) {
                utils.timestampedLog('Callkeep: call', callUUID, 'already received on web socket');
            }
            this.showAlertPanel(callUUID, from, displayName);
        } else {
            if (this._calls.has(callUUID) || force) {
                // on Android display alert panel only after websocket call arrives
                // force is required when Android is locked, if we do not bring up the panel, the app will not wake up
                if (!skipNativePanel || force) {
                    this.showAlertPanel(callUUID, from, displayName);
                } else {
                    utils.timestampedLog('Callkeep: call', callUUID, 'skipped display of native panel');
                }
            } else {
                utils.timestampedLog('Callkeep: waiting for call', callUUID, 'on web socket');
                this.showAlertPanel(callUUID, from, displayName);
            }
        }
    }

    incomingCallFromWebSocket(call, accept=false, skipNativePanel=false) {
        this.addWebsocketCall(call);

        utils.timestampedLog('Callkeep: handle incoming websocket call', call.id);

        // if the call came via push and was already accepted or rejected
        if (this.webSocketActions.get(call.id)) {
            let action = this.webSocketActions.get(call.id);
            utils.timestampedLog('Callkeep: execute action decided earlier', action);

            if (action === 'accept') {
                this.sylkAcceptCall(call.id);
            } else {
                this.sylkRejectCall(call.id);
            }

            this.webSocketActions.delete(call.id);

        } else {
            if (accept) {
                this.acceptCall(call.id);
            } else if (!skipNativePanel) {
                if (Platform.OS === 'ios') {
                    this.showAlertPanelforCall(call);
                }
            }
        }

        // Emit event.
        this._emitSessionsChange(true);
    }

    handleConference(callUUID, room, from_uri, displayName, outgoingMedia) {

        if (this._conferences.has(callUUID)) {
            return;
        }

        this._conferences.set(callUUID, {room: room, from: from_uri});
        this.outgoingMedia = outgoingMedia;

        utils.timestampedLog('CallKeep: handle conference', callUUID, 'from', from_uri, 'to room', room);

        this.showAlertPanel(callUUID, from_uri, displayName);

        this._timeouts.set(callUUID, setTimeout(() => {
            utils.timestampedLog('Callkeep: conference timeout', callUUID);
            this.timeoutCall(callUUID, from_uri);
            this.endCall(callUUID, CK_CONSTANTS.END_CALL_REASONS.MISSED);
            this._timeouts.delete(callUUID);
        }, 45000));

        this._emitSessionsChange(true);
    }

    showAlertPanelforCall(call, force=false) {
        const hasVideo = call.mediaTypes && call.mediaTypes.video;
        this.showAlertPanel(call.id, call.remoteIdentity.uri, call.remoteIdentity.displayName, hasVideo);
    }

    showAlertPanel(callUUID, from, displayName, hasVideo=false) {
        if (this._alertedCalls.has(callUUID)) {
            //utils.timestampedLog('Callkeep: call', callUUID, 'was already alerted');
            return;
        }

        let panelFrom = from;
        const username = from.split('@')[0];
        const isPhoneNumber = username.match(/^(\+|0)(\d+)$/);
        if (isPhoneNumber) {
            panelFrom = isPhoneNumber;
        } else {
            panelFrom = from.indexOf('@guest.') > -1 ? displayName : from;
        }

        utils.timestampedLog('Callkeep: ALERT PANEL for', callUUID, 'from', from, '(', displayName, ')');

        this._alertedCalls.set(callUUID, Date.now());

        if (Platform.OS === 'ios') {
            this.callKeep.displayIncomingCall(callUUID, panelFrom, displayName, 'email', hasVideo);
        } else if (Platform.OS === 'android') {
            this.callKeep.displayIncomingCall(callUUID, panelFrom, displayName);
        }
    }

   _startedCall(data) {
        //utils.timestampedLog("Callkeep: STARTED NATIVE CALL", data.callUUID);
        if (!this._calls.has(data.callUUID)) {
            // call has started from OS native dialer
            this.startCallFromOutside(data);
        }
    }

    _displayIncomingCall(data) {
        utils.timestampedLog('Callkeep: Incoming alert panel displayed');
    }

    _emitSessionsChange(countChanged) {
        this.emit('sessionschange', countChanged);
    }

    destroy() {
        this._RNCallKeep.removeEventListener('acceptCall', this._boundRnAccept);
        this._RNCallKeep.removeEventListener('endCall', this._boundRnEnd);
        this._RNCallKeep.removeEventListener('didPerformSetMutedCallAction', this._boundRnMute);
        this._RNCallKeep.removeEventListener('didActivateAudioSession',  this._boundRnActiveAudioCall);
        this._RNCallKeep.removeEventListener('didDeactivateAudioSession', this._boundRnDeactiveAudioCall);
        this._RNCallKeep.removeEventListener('didPerformDTMFAction', this._boundRnDTMF);
        this._RNCallKeep.removeEventListener('didResetProvider', this._boundRnProviderReset);
        this._RNCallKeep.removeEventListener('didReceiveStartCallAction', this.boundRnStartAction);
        this._RNCallKeep.removeEventListener('didDisplayIncomingCall', this.boundRnDisplayIncomingCall);

    }
}
