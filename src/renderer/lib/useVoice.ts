import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { apiRequest } from './api';
import { playVoiceSound, primeVoiceSounds } from './voiceSounds';

interface VoiceConfig { iceServers: RTCIceServer[]; turnConfigured: boolean }
interface VoiceJoinReply { ok: boolean; peers?: string[]; error?: string }
interface VoiceSignal { channelId: string; targetUserId: string; userId?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
interface VoiceState { channelId: string; stream: MediaStream; muted: boolean; deafened: boolean; turnConfigured: boolean; remoteStreams: Record<string, MediaStream> }

export function useVoice(socket: Socket | null, apiUrl: string, token: string | null, userId: string | null, notify: (message: string) => void, soundsEnabled = true, inputDeviceId = '') {
  const [voice, setVoice] = useState<VoiceState | null>(null);
  const voiceRef = useRef<VoiceState | null>(null);
  const socketRef = useRef<Socket | null>(socket);
  const peers = useRef(new Map<string, RTCPeerConnection>());
  const config = useRef<VoiceConfig | null>(null);
  socketRef.current = socket;
  voiceRef.current = voice;

  const closePeer = useCallback((userId: string) => {
    peers.current.get(userId)?.close();
    peers.current.delete(userId);
    const current = voiceRef.current;
    if (current) {
      const remoteStreams = { ...current.remoteStreams };
      delete remoteStreams[userId];
      const next = { ...current, remoteStreams };
      voiceRef.current = next;
      setVoice(next);
    }
  }, []);

  const createPeer = useCallback((userId: string, initiator: boolean) => {
    const current = voiceRef.current, activeSocket = socketRef.current;
    if (!current || !activeSocket || peers.current.has(userId)) return;
    const peer = new RTCPeerConnection({ iceServers: config.current?.iceServers ?? [] });
    peers.current.set(userId, peer);
    current.stream.getTracks().forEach((track) => peer.addTrack(track, current.stream));
    peer.ontrack = (event) => {
      const next = { ...(voiceRef.current?.remoteStreams ?? {}), [userId]: event.streams[0] ?? new MediaStream([event.track]) };
      if (voiceRef.current) { const updated = { ...voiceRef.current, remoteStreams: next }; voiceRef.current = updated; setVoice(updated); }
    };
    peer.onicecandidate = (event) => {
      if (event.candidate) activeSocket.emit('voice:signal', { channelId: current.channelId, targetUserId: userId, candidate: event.candidate.toJSON() } satisfies VoiceSignal);
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') closePeer(userId);
    };
    if (initiator) void peer.createOffer().then((offer) => peer.setLocalDescription(offer)).then(() => {
      activeSocket.emit('voice:signal', { channelId: current.channelId, targetUserId: userId, description: peer.localDescription?.toJSON() } satisfies VoiceSignal);
    }).catch((error: unknown) => notify(error instanceof Error ? `Voice connection failed: ${error.message}` : 'Voice connection failed.'));
    return peer;
  }, [closePeer, notify]);

  const stopVoice = useCallback((playCue: boolean) => {
    const current = voiceRef.current;
    if (!current) return;
    if (playCue) playVoiceSound('leave', soundsEnabled);
    socketRef.current?.emit('voice:leave', current.channelId);
    current.stream.getTracks().forEach((track) => track.stop());
    peers.current.forEach((peer) => peer.close());
    peers.current.clear();
    config.current = null;
    voiceRef.current = null;
    setVoice(null);
  }, [soundsEnabled]);

  const leave = useCallback(() => stopVoice(true), [stopVoice]);

  const join = useCallback(async (channelId: string) => {
    if (voiceRef.current?.channelId === channelId) return;
    primeVoiceSounds(soundsEnabled);
    if (voiceRef.current) stopVoice(false);
    if (!socketRef.current?.connected) { notify('Connect to the server before joining voice.'); return; }
    if (!navigator.mediaDevices?.getUserMedia) { notify('This device does not provide microphone access.'); return; }
    try {
      const result = await apiRequest<VoiceConfig>(apiUrl, token, '/api/voice/config');
      config.current = result;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      const initial: VoiceState = { channelId, stream, muted: false, deafened: false, turnConfigured: result.turnConfigured, remoteStreams: {} };
      voiceRef.current = initial;
      setVoice(initial);
      socketRef.current.emit('voice:join', channelId, (reply: VoiceJoinReply) => {
        if (!reply?.ok) { stopVoice(false); notify(reply?.error ?? 'Unable to join this voice channel.'); return; }
        playVoiceSound('join', soundsEnabled);
        (reply.peers ?? []).forEach((peerId) => createPeer(peerId, Boolean(userId && userId < peerId)));
      });
    } catch (error) {
      stopVoice(false);
      notify(error instanceof Error ? error.message : 'Microphone access was unavailable. Check the Windows privacy settings and try again.');
    }
  }, [apiUrl, token, userId, inputDeviceId, createPeer, stopVoice, notify, soundsEnabled]);

  const selectInputDevice = useCallback(async (deviceId: string) => {
    const current = voiceRef.current;
    if (!current) return;
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      const nextTrack = nextStream.getAudioTracks()[0];
      if (!nextTrack) throw new Error('The selected microphone has no audio track.');
      const oldTrack = current.stream.getAudioTracks()[0];
      peers.current.forEach((peer) => {
        const sender = peer.getSenders().find((item) => item.track?.kind === 'audio');
        if (sender) void sender.replaceTrack(nextTrack);
      });
      const stream = new MediaStream([...current.stream.getVideoTracks(), nextTrack]);
      nextTrack.enabled = !current.muted;
      oldTrack?.stop();
      const next = { ...current, stream };
      voiceRef.current = next;
      setVoice(next);
    } catch (error) { notify(error instanceof Error ? `Microphone could not be changed: ${error.message}` : 'Microphone could not be changed.'); }
  }, [notify]);

  const selectOutputDevice = useCallback(async (deviceId: string) => {
    if (!('setSinkId' in HTMLMediaElement.prototype)) {
      notify('This app audio backend does not support choosing a speaker.');
      return;
    }
    try {
      await Promise.all([...document.querySelectorAll<HTMLAudioElement>('.remote-audio-bin audio')].map((audio) =>
        (audio as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId)));
    } catch (error) { notify(error instanceof Error ? `Speaker could not be changed: ${error.message}` : 'Speaker could not be changed.'); }
  }, [notify]);

  const toggleMute = useCallback(() => {
    const current = voiceRef.current;
    if (!current) return;
    const muted = !current.muted;
    current.stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    const next = { ...current, muted };
    voiceRef.current = next; setVoice(next);
  }, []);

  const toggleDeafen = useCallback(() => {
    const current = voiceRef.current;
    if (!current) return;
    const next = { ...current, deafened: !current.deafened };
    voiceRef.current = next; setVoice(next);
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onPeerJoined = ({ userId: peerId }: { userId: string }) => {
      const current = voiceRef.current;
      if (current && userId && userId < peerId) createPeer(peerId, true);
    };
    const onPeerLeft = ({ userId }: { userId: string }) => closePeer(userId);
    const onSignal = async (signal: VoiceSignal) => {
      const current = voiceRef.current;
      if (!current || signal.channelId !== current.channelId || !signal.userId) return;
      let peer = peers.current.get(signal.userId);
      if (!peer) peer = createPeer(signal.userId, false);
      if (!peer) return;
      try {
        if (signal.description) {
          await peer.setRemoteDescription(signal.description);
          if (signal.description.type === 'offer') {
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            socket.emit('voice:signal', { channelId: current.channelId, targetUserId: signal.userId, description: peer.localDescription?.toJSON() } satisfies VoiceSignal);
          }
        } else if (signal.candidate) await peer.addIceCandidate(signal.candidate);
      } catch (error) { notify(error instanceof Error ? `Voice connection failed: ${error.message}` : 'Voice connection failed.'); }
    };
    socket.on('voice:peer-joined', onPeerJoined);
    socket.on('voice:peer-left', onPeerLeft);
    socket.on('voice:signal', onSignal);
    return () => { socket.off('voice:peer-joined', onPeerJoined); socket.off('voice:peer-left', onPeerLeft); socket.off('voice:signal', onSignal); };
  }, [socket, userId, createPeer, closePeer, notify]);

  useEffect(() => { if (voice && (!socket?.connected || !token)) stopVoice(false); }, [socket, socket?.connected, token, voice, stopVoice]);
  useEffect(() => () => { voiceRef.current?.stream.getTracks().forEach((track) => track.stop()); peers.current.forEach((peer) => peer.close()); }, []);

  return { voice, join, leave, toggleMute, toggleDeafen, selectInputDevice, selectOutputDevice };
}
