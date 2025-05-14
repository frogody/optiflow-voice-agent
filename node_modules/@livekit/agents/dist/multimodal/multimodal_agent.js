import {
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RoomEvent,
  TrackPublishOptions,
  TrackSource
} from "@livekit/rtc-node";
import { EventEmitter } from "node:events";
import { AudioByteStream } from "../audio.js";
import {
  ATTRIBUTE_TRANSCRIPTION_FINAL,
  ATTRIBUTE_TRANSCRIPTION_TRACK_ID,
  TOPIC_TRANSCRIPTION
} from "../constants.js";
import * as llm from "../llm/index.js";
import { log } from "../log.js";
import { TextAudioSynchronizer, defaultTextSyncOptions } from "../transcription.js";
import { findMicroTrackId } from "../utils.js";
import { AgentPlayout } from "./agent_playout.js";
class RealtimeSession extends EventEmitter {
}
class RealtimeModel {
}
const AGENT_STATE_ATTRIBUTE = "lk.agent.state";
class MultimodalAgent extends EventEmitter {
  model;
  room = null;
  linkedParticipant = null;
  subscribedTrack = null;
  readMicroTask = null;
  #textResponseRetries = 0;
  #maxTextResponseRetries;
  constructor({
    model,
    chatCtx,
    fncCtx,
    maxTextResponseRetries = 5,
    noiseCancellation
  }) {
    super();
    this.model = model;
    this.#chatCtx = chatCtx;
    this.#fncCtx = fncCtx;
    this.#maxTextResponseRetries = maxTextResponseRetries;
    this.#noiseCancellation = noiseCancellation;
  }
  #participant = null;
  #agentPublication = null;
  #localTrackSid = null;
  #localSource = null;
  #agentPlayout = null;
  #playingHandle = void 0;
  #logger = log();
  #session = null;
  #fncCtx = void 0;
  #chatCtx = void 0;
  #noiseCancellation = void 0;
  #_started = false;
  #_pendingFunctionCalls = /* @__PURE__ */ new Set();
  #_speaking = false;
  get fncCtx() {
    return this.#fncCtx;
  }
  set fncCtx(ctx) {
    this.#fncCtx = ctx;
    if (this.#session) {
      this.#session.fncCtx = ctx;
    }
  }
  get #pendingFunctionCalls() {
    return this.#_pendingFunctionCalls;
  }
  set #pendingFunctionCalls(calls) {
    this.#_pendingFunctionCalls = calls;
    this.#updateState();
  }
  get #speaking() {
    return this.#_speaking;
  }
  set #speaking(isSpeaking) {
    this.#_speaking = isSpeaking;
    this.#updateState();
  }
  get #started() {
    return this.#_started;
  }
  set #started(started) {
    this.#_started = started;
    this.#updateState();
  }
  start(room, participant = null) {
    return new Promise(async (resolve, reject) => {
      var _a;
      if (this.#started) {
        reject(new Error("MultimodalAgent already started"));
      }
      this.#updateState();
      room.on(RoomEvent.ParticipantConnected, (participant2) => {
        if (this.linkedParticipant) {
          return;
        }
        this.#linkParticipant(participant2.identity);
      });
      room.on(
        RoomEvent.TrackPublished,
        (trackPublication, participant2) => {
          if (this.linkedParticipant && participant2.identity === this.linkedParticipant.identity && trackPublication.source === TrackSource.SOURCE_MICROPHONE && !trackPublication.subscribed) {
            trackPublication.setSubscribed(true);
          }
        }
      );
      room.on(RoomEvent.TrackSubscribed, this.#handleTrackSubscription.bind(this));
      this.room = room;
      this.#participant = participant;
      this.#localSource = new AudioSource(this.model.sampleRate, this.model.numChannels);
      this.#agentPlayout = new AgentPlayout(
        this.#localSource,
        this.model.sampleRate,
        this.model.numChannels,
        this.model.inFrameSize,
        this.model.outFrameSize
      );
      const onPlayoutStarted = () => {
        this.emit("agent_started_speaking");
        this.#speaking = true;
      };
      const onPlayoutStopped = (interrupted) => {
        this.emit("agent_stopped_speaking");
        this.#speaking = false;
        if (this.#playingHandle) {
          let text = this.#playingHandle.synchronizer.playedText;
          if (interrupted) {
            text += "\u2026";
          }
          const msg = llm.ChatMessage.create({
            role: llm.ChatRole.ASSISTANT,
            text
          });
          if (interrupted) {
            this.emit("agent_speech_interrupted", msg);
          } else {
            this.emit("agent_speech_committed", msg);
          }
          this.#logger.child({ transcription: text, interrupted }).debug("committed agent speech");
        }
      };
      this.#agentPlayout.on("playout_started", onPlayoutStarted);
      this.#agentPlayout.on("playout_stopped", onPlayoutStopped);
      const track = LocalAudioTrack.createAudioTrack("assistant_voice", this.#localSource);
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      this.#agentPublication = await ((_a = room.localParticipant) == null ? void 0 : _a.publishTrack(track, options)) || null;
      if (!this.#agentPublication) {
        this.#logger.error("Failed to publish track");
        reject(new Error("Failed to publish track"));
        return;
      }
      await this.#agentPublication.waitForSubscription();
      if (participant) {
        if (typeof participant === "string") {
          this.#linkParticipant(participant);
        } else {
          this.#linkParticipant(participant.identity);
        }
      } else {
        for (const participant2 of room.remoteParticipants.values()) {
          this.#linkParticipant(participant2.identity);
          break;
        }
      }
      this.#session = this.model.session({ fncCtx: this.#fncCtx, chatCtx: this.#chatCtx });
      this.#started = true;
      this.#session.on("response_content_added", (message) => {
        var _a2;
        if (message.contentType === "text") return;
        const synchronizer = new TextAudioSynchronizer(defaultTextSyncOptions);
        synchronizer.on("textUpdated", async (text) => {
          await this.#publishTranscription(
            this.room.localParticipant.identity,
            this.#getLocalTrackSid(),
            text.text,
            text.final,
            text.id
          );
        });
        const handle = (_a2 = this.#agentPlayout) == null ? void 0 : _a2.play(
          message.itemId,
          message.contentIndex,
          synchronizer,
          message.textStream,
          message.audioStream
        );
        this.#playingHandle = handle;
      });
      this.#session.on("response_content_done", (message) => {
        if (message.contentType === "text") {
          if (this.#textResponseRetries >= this.#maxTextResponseRetries) {
            throw new Error(
              `The OpenAI Realtime API returned a text response after ${this.#maxTextResponseRetries} retries. Please try to reduce the number of text system or assistant messages in the chat context.`
            );
          }
          this.#textResponseRetries++;
          this.#logger.child({
            itemId: message.itemId,
            text: message.text,
            retries: this.#textResponseRetries
          }).warn(
            "The OpenAI Realtime API returned a text response instead of audio. Attempting to recover to audio mode..."
          );
          this.#session.recoverFromTextResponse(message.itemId);
        } else {
          this.#textResponseRetries = 0;
        }
      });
      this.#session.on("input_speech_committed", async (ev) => {
        var _a2, _b;
        const participantIdentity = (_a2 = this.linkedParticipant) == null ? void 0 : _a2.identity;
        const trackSid = (_b = this.subscribedTrack) == null ? void 0 : _b.sid;
        if (participantIdentity && trackSid) {
          await this.#publishTranscription(participantIdentity, trackSid, "\u2026", false, ev.itemId);
        } else {
          this.#logger.error("Participant or track not set");
        }
      });
      this.#session.on("input_speech_transcription_completed", async (ev) => {
        var _a2, _b;
        const transcription = ev.transcript;
        const participantIdentity = (_a2 = this.linkedParticipant) == null ? void 0 : _a2.identity;
        const trackSid = (_b = this.subscribedTrack) == null ? void 0 : _b.sid;
        if (participantIdentity && trackSid) {
          await this.#publishTranscription(
            participantIdentity,
            trackSid,
            transcription,
            true,
            ev.itemId
          );
        } else {
          this.#logger.error("Participant or track not set");
        }
        const userMsg = llm.ChatMessage.create({
          role: llm.ChatRole.USER,
          text: transcription
        });
        this.emit("user_speech_committed", userMsg);
        this.#logger.child({ transcription }).debug("committed user speech");
      });
      this.#session.on("input_speech_started", async (ev) => {
        var _a2, _b;
        this.emit("user_started_speaking");
        if (this.#playingHandle && !this.#playingHandle.done) {
          this.#playingHandle.interrupt();
          this.#session.conversation.item.truncate(
            this.#playingHandle.itemId,
            this.#playingHandle.contentIndex,
            Math.floor(this.#playingHandle.audioSamples / 24e3 * 1e3)
          );
          this.#playingHandle = void 0;
        }
        const participantIdentity = (_a2 = this.linkedParticipant) == null ? void 0 : _a2.identity;
        const trackSid = (_b = this.subscribedTrack) == null ? void 0 : _b.sid;
        if (participantIdentity && trackSid) {
          await this.#publishTranscription(participantIdentity, trackSid, "\u2026", false, ev.itemId);
        }
      });
      this.#session.on("input_speech_stopped", (ev) => {
        this.emit("user_stopped_speaking");
      });
      this.#session.on("function_call_started", (ev) => {
        this.#pendingFunctionCalls.add(ev.callId);
        this.#updateState();
      });
      this.#session.on("function_call_completed", (ev) => {
        this.#pendingFunctionCalls.delete(ev.callId);
        this.#updateState();
      });
      this.#session.on("function_call_failed", (ev) => {
        this.#pendingFunctionCalls.delete(ev.callId);
        this.#updateState();
      });
      this.#session.on("metrics_collected", (metrics) => {
        this.emit("metrics_collected", metrics);
      });
      resolve(this.#session);
    });
  }
  #linkParticipant(participantIdentity) {
    if (!this.room) {
      this.#logger.error("Room is not set");
      return;
    }
    this.linkedParticipant = this.room.remoteParticipants.get(participantIdentity) || null;
    if (!this.linkedParticipant) {
      this.#logger.error(`Participant with identity ${participantIdentity} not found`);
      return;
    }
    if (this.linkedParticipant.trackPublications.size > 0) {
      this.#subscribeToMicrophone();
    }
    for (const publication of this.linkedParticipant.trackPublications.values()) {
      if (publication.source === TrackSource.SOURCE_MICROPHONE && publication.track) {
        this.#handleTrackSubscription(publication.track, publication, this.linkedParticipant);
        break;
      }
    }
  }
  #subscribeToMicrophone() {
    if (!this.linkedParticipant) {
      this.#logger.error("Participant is not set");
      return;
    }
    let microphonePublication = void 0;
    for (const publication of this.linkedParticipant.trackPublications.values()) {
      if (publication.source === TrackSource.SOURCE_MICROPHONE) {
        microphonePublication = publication;
        break;
      }
    }
    if (!microphonePublication) {
      return;
    }
    if (!microphonePublication.subscribed) {
      microphonePublication.setSubscribed(true);
    }
  }
  #handleTrackSubscription(track, publication, participant) {
    var _a;
    if (publication.source !== TrackSource.SOURCE_MICROPHONE || participant.identity !== ((_a = this.linkedParticipant) == null ? void 0 : _a.identity)) {
      return;
    }
    const readAudioStreamTask = async (audioStream) => {
      const bstream = new AudioByteStream(
        this.model.sampleRate,
        this.model.numChannels,
        this.model.inFrameSize
      );
      for await (const frame of audioStream) {
        const audioData = frame.data;
        for (const frame2 of bstream.write(audioData.buffer)) {
          this.#session.inputAudioBuffer.append(frame2);
        }
      }
    };
    this.subscribedTrack = track;
    this.readMicroTask = new Promise((resolve, reject) => {
      const audioStreamOptions = {
        sampleRate: this.model.sampleRate,
        numChannels: this.model.numChannels,
        ...this.#noiseCancellation ? { noiseCancellation: this.#noiseCancellation } : {}
      };
      readAudioStreamTask(new AudioStream(track, audioStreamOptions)).then(resolve).catch(reject);
    });
  }
  #getLocalTrackSid() {
    if (!this.#localTrackSid && this.room && this.room.localParticipant) {
      this.#localTrackSid = findMicroTrackId(this.room, this.room.localParticipant.identity);
    }
    return this.#localTrackSid;
  }
  async #publishTranscription(participantIdentity, trackSid, text, isFinal, id) {
    var _a;
    this.#logger.debug(
      `Publishing transcription ${participantIdentity} ${trackSid} ${text} ${isFinal} ${id}`
    );
    if (!((_a = this.room) == null ? void 0 : _a.localParticipant)) {
      this.#logger.error("Room or local participant not set");
      return;
    }
    this.room.localParticipant.publishTranscription({
      participantIdentity,
      trackSid,
      segments: [
        {
          text,
          final: isFinal,
          id,
          startTime: BigInt(0),
          endTime: BigInt(0),
          language: ""
        }
      ]
    });
    const stream = await this.room.localParticipant.streamText({
      topic: TOPIC_TRANSCRIPTION,
      senderIdentity: participantIdentity,
      attributes: {
        [ATTRIBUTE_TRANSCRIPTION_TRACK_ID]: trackSid,
        [ATTRIBUTE_TRANSCRIPTION_FINAL]: isFinal.toString()
      }
    });
    await stream.write(text);
    await stream.close();
  }
  #updateState() {
    let newState = "initializing";
    if (this.#pendingFunctionCalls.size > 0) {
      newState = "thinking";
    } else if (this.#speaking) {
      newState = "speaking";
    } else if (this.#started) {
      newState = "listening";
    }
    this.#setState(newState);
  }
  #setState(state) {
    var _a;
    if (((_a = this.room) == null ? void 0 : _a.isConnected) && this.room.localParticipant) {
      const currentState = this.room.localParticipant.attributes[AGENT_STATE_ATTRIBUTE];
      if (currentState !== state) {
        this.room.localParticipant.setAttributes({
          [AGENT_STATE_ATTRIBUTE]: state
        });
        this.#logger.debug(`${AGENT_STATE_ATTRIBUTE}: ${currentState} ->${state}`);
      }
    }
  }
}
export {
  AGENT_STATE_ATTRIBUTE,
  MultimodalAgent,
  RealtimeModel,
  RealtimeSession
};
//# sourceMappingURL=multimodal_agent.js.map