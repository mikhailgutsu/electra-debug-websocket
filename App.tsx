import { StatusBar } from "expo-status-bar";
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Image,
} from "react-native";
import { useState, useRef, useEffect } from "react";

type ViewMode = "text" | "bytes" | "image" | "stream";

interface MessageData {
  timestamp: string;
  data: string;
  type: "system" | "data";
  streamInfo?: StreamInfo;
  binaryData?: Uint8Array;
}

interface StreamInfo {
  frameId: number;
  chunkId: number;
  chunksTotal: number;
  frameSize: number;
  width: number;
  height: number;
  payloadLen: number;
}

interface FrameState {
  receivedChunks: Set<number>;
  totalChunks: number;
  frameSize: number;
}

// Frame Assembler - собирает чанки в один фрейм
class FrameAssembler {
  buffer: Uint8Array;
  receivedChunks: Set<number>;
  totalChunks: number;
  frameSize: number;
  frameId: number;
  width: number;
  height: number;
  lastUpdate: number;
  chunkPayloadSize: number = 32768; // CHUNK_PAYLOAD из C++

  constructor(header: StreamInfo) {
    this.frameId = header.frameId;
    this.frameSize = header.frameSize;
    this.totalChunks = header.chunksTotal;
    this.width = header.width;
    this.height = header.height;
    this.buffer = new Uint8Array(header.frameSize);
    this.receivedChunks = new Set();
    this.lastUpdate = Date.now();
  }

  addChunk(chunkId: number, payload: Uint8Array): boolean {
    if (chunkId >= this.totalChunks) {
      console.warn(`⚠️ Chunk ${chunkId} >= total chunks ${this.totalChunks}`);
      return false;
    }
    if (this.receivedChunks.has(chunkId)) {
      return false;
    }

    // Копируем payload в буфер по смещению
    const offset = chunkId * this.chunkPayloadSize;

    // Проверяем границы буфера
    if (offset >= this.buffer.length) {
      console.error(
        `❌ Offset ${offset} >= buffer length ${this.buffer.length}`,
      );
      return false;
    }

    // Для последнего чанка может быть меньше данных
    const availableSpace = this.buffer.length - offset;
    const bytesToCopy = Math.min(payload.length, availableSpace);

    if (bytesToCopy < payload.length) {
      console.log(
        `📦 Chunk ${chunkId}: copying ${bytesToCopy}/${payload.length} bytes (last chunk)`,
      );
    }

    // Копируем только то, что помещается
    this.buffer.set(payload.subarray(0, bytesToCopy), offset);
    this.receivedChunks.add(chunkId);
    this.lastUpdate = Date.now();

    return this.isComplete();
  }

  isComplete(): boolean {
    return this.receivedChunks.size === this.totalChunks;
  }

  getJpegData(): Uint8Array {
    // Возвращаем только заполненную часть буфера
    const actualSize =
      (this.totalChunks - 1) * this.chunkPayloadSize +
      (this.frameSize - (this.totalChunks - 1) * this.chunkPayloadSize);
    return this.buffer.slice(0, this.frameSize);
  }
}

// Reassembler - управляет несколькими фреймами
class Reassembler {
  frames: Map<number, FrameAssembler>;
  maxFrames: number;

  constructor(maxFrames: number = 8) {
    this.frames = new Map();
    this.maxFrames = maxFrames;
  }

  push(header: StreamInfo, payload: Uint8Array): FrameAssembler | null {
    let frame = this.frames.get(header.frameId);

    if (!frame) {
      frame = new FrameAssembler(header);
      this.frames.set(header.frameId, frame);
    }

    const isComplete = frame.addChunk(header.chunkId, payload);

    if (isComplete) {
      this.frames.delete(header.frameId);
      return frame;
    }

    return null;
  }

  gc(maxAgeMs: number = 1000): void {
    const now = Date.now();
    if (this.frames.size <= this.maxFrames) return;

    const toDelete: number[] = [];
    this.frames.forEach((frame, frameId) => {
      if (now - frame.lastUpdate > maxAgeMs) {
        toDelete.push(frameId);
      }
    });

    toDelete.forEach((frameId) => this.frames.delete(frameId));
  }
}

export default function App() {
  const [ip, setIp] = useState("185.181.228.243");
  const [port, setPort] = useState("35189");
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("text");
  const [currentFrame, setCurrentFrame] = useState<string | null>(null); // base64 JPEG
  const [fps, setFps] = useState<number>(0);
  const websocket = useRef<WebSocket | null>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const frameStates = useRef<Map<number, FrameState>>(new Map());
  const reassembler = useRef<Reassembler>(new Reassembler());
  const fpsCounter = useRef({ count: 0, lastTime: 0 });

  // MYIR Protocol Constants
  const MYIR_MAGIC = 0x4d594952;
  const MYIR_VER = 3;

  // Parse MYIR header from binary data
  const parseMyirHeader = (data: ArrayBuffer): StreamInfo | null => {
    try {
      if (data.byteLength < 36) return null; // Header is 36 bytes!

      const view = new DataView(data);
      const magic = view.getUint32(0, false); // big-endian

      if (magic !== MYIR_MAGIC) return null;

      const ver = view.getUint8(4);
      if (ver !== MYIR_VER) return null;

      // Skip: stream(1), codec(1), flags(1)
      const width = view.getUint16(8, false);
      const height = view.getUint16(10, false);
      // Skip: pts(8)
      const frameId = view.getUint32(20, false);
      const frameSize = view.getUint32(24, false);
      const chunkId = view.getUint16(28, false);
      const chunksTotal = view.getUint16(30, false);
      const payloadLen = view.getUint16(32, false); // Читаем payload_len

      return {
        frameId,
        chunkId,
        chunksTotal,
        frameSize,
        width,
        height,
        payloadLen,
      };
    } catch (e) {
      console.error("MYIR parse error:", e);
      return null;
    }
  };

  // Convert Uint8Array to base64 string (optimized)
  const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
    const chunkSize = 8192;
    let binary = "";

    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }

    return btoa(binary);
  };

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollViewRef.current) {
      scrollViewRef.current.scrollToEnd({ animated: true });
    }
  }, [messages]);

  // Clear console when view mode changes
  const changeViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    // Keep only system messages when switching modes
    setMessages((prev) => prev.filter((msg) => msg.type === "system"));
  };

  const connectWebSocket = () => {
    if (websocket.current) {
      websocket.current.close();
    }

    const wsUrl = `ws://${ip}:${port}`;
    setMessages([
      {
        timestamp: new Date().toLocaleTimeString(),
        data: `Connecting to ${wsUrl}...`,
        type: "system",
      },
    ]);

    try {
      const ws = new WebSocket(wsUrl);
      // Set binary type to arraybuffer for React Native
      (ws as any).binaryType = "arraybuffer";

      ws.onopen = () => {
        setIsConnected(true);
        // Reset FPS counter
        fpsCounter.current = { count: 0, lastTime: 0 };
        setFps(0);
        setCurrentFrame(null);

        setMessages((prev) => [
          ...prev,
          {
            timestamp: new Date().toLocaleTimeString(),
            data: `✅ Connected to ${wsUrl}`,
            type: "system",
          },
        ]);
      };

      ws.onmessage = (event) => {
        const timestamp = new Date().toLocaleTimeString();

        // Try to parse as binary MYIR protocol
        const processBuffer = (buffer: ArrayBuffer) => {
          const header = parseMyirHeader(buffer);

          if (header) {
            // Update frame state for UI
            let frameState = frameStates.current.get(header.frameId);
            if (!frameState) {
              frameState = {
                receivedChunks: new Set(),
                totalChunks: header.chunksTotal,
                frameSize: header.frameSize,
              };
              frameStates.current.set(header.frameId, frameState);
            }
            frameState.receivedChunks.add(header.chunkId);

            // Extract payload (skip 36-byte header, use payload_len from header)
            const HDR_SIZE = 36; // C++ struct size: 4+4+4+8+8+8 = 36 bytes!
            const payload = new Uint8Array(buffer, HDR_SIZE, header.payloadLen);

            // Log first chunk of each frame
            if (header.chunkId === 0) {
              console.log(
                `🎬 New frame ${header.frameId} started: ${header.width}x${header.height}, ${header.chunksTotal} chunks, ${header.frameSize} bytes total`,
              );
              console.log(`👀 First chunk payload: ${header.payloadLen} bytes`);
            }

            // Push to reassembler
            const completeFrame = reassembler.current.push(header, payload);

            if (completeFrame) {
              // Update FPS counter
              const now = Date.now();

              // Initialize lastTime on first frame
              if (fpsCounter.current.lastTime === 0) {
                fpsCounter.current.lastTime = now;
              }

              fpsCounter.current.count++;
              const elapsed = now - fpsCounter.current.lastTime;
              let currentFps = fps;

              if (elapsed >= 1000) {
                currentFps = (fpsCounter.current.count * 1000) / elapsed;
                setFps(Math.round(currentFps * 10) / 10);
                fpsCounter.current.count = 0;
                fpsCounter.current.lastTime = now;
              }

              // Frame complete! Convert to base64 for Image component
              const jpegData = completeFrame.getJpegData();

              console.log(
                `🎬 Frame ${header.frameId}: JPEG size = ${jpegData.length} bytes`,
              );

              // Check JPEG magic bytes (0xFF 0xD8)
              if (jpegData.length > 2) {
                const isJpeg = jpegData[0] === 0xff && jpegData[1] === 0xd8;
                console.log(
                  `🔍 JPEG magic bytes: ${jpegData[0].toString(16)} ${jpegData[1].toString(16)} - ${isJpeg ? "✅ Valid JPEG" : "❌ NOT JPEG!"}`,
                );

                if (!isJpeg) {
                  console.error(
                    "❌ Invalid JPEG data! First 16 bytes:",
                    Array.from(jpegData.slice(0, 16))
                      .map((b) => b.toString(16).padStart(2, "0"))
                      .join(" "),
                  );
                }
              }

              // Convert to base64
              const base64 = uint8ArrayToBase64(jpegData);
              console.log(
                `📦 Base64 length = ${base64.length} chars, first 50: ${base64.substring(0, 50)}`,
              );

              const imageUri = `data:image/jpeg;base64,${base64}`;
              setCurrentFrame(imageUri);

              // Clean up old frame states
              frameStates.current.delete(header.frameId);

              console.log(
                `✅ Frame ${header.frameId} complete: ${header.width}x${header.height}, FPS: ${currentFps.toFixed(1)}`,
              );
            }

            // GC old incomplete frames
            reassembler.current.gc();

            // Clean up old frame states (keep only last 10)
            if (frameStates.current.size > 10) {
              const oldestFrame = Math.min(...frameStates.current.keys());
              frameStates.current.delete(oldestFrame);
            }

            // Add message with stream info
            setMessages((prev) => [
              ...prev,
              {
                timestamp,
                data: `Chunk ${header.chunkId + 1}/${header.chunksTotal}`,
                type: "data",
                streamInfo: header,
                binaryData: new Uint8Array(buffer),
              },
            ]);
          } else {
            // Not MYIR protocol
            setMessages((prev) => [
              ...prev,
              {
                timestamp,
                data: `Binary data: ${buffer.byteLength} bytes (not MYIR)`,
                type: "data",
                binaryData: new Uint8Array(buffer),
              },
            ]);
          }
        };

        // Handle different data types
        if (event.data instanceof ArrayBuffer) {
          // React Native with binaryType='arraybuffer'
          processBuffer(event.data);
        } else if (event.data instanceof Blob) {
          // Browser fallback
          event.data.arrayBuffer().then(processBuffer);
        } else if (typeof event.data === "string") {
          // Check if it's base64 encoded binary
          try {
            // Try to decode as base64
            const binaryString = atob(event.data);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            processBuffer(bytes.buffer);
          } catch (e) {
            // Text data
            setMessages((prev) => [
              ...prev,
              {
                timestamp,
                data: event.data,
                type: "data",
              },
            ]);
          }
        } else {
          // Unknown format - text fallback
          setMessages((prev) => [
            ...prev,
            {
              timestamp,
              data: String(event.data),
              type: "data",
            },
          ]);
        }
      };

      ws.onerror = (error: Event) => {
        setMessages((prev) => [
          ...prev,
          {
            timestamp: new Date().toLocaleTimeString(),
            data: `❌ Error: Connection error`,
            type: "system",
          },
        ]);
      };

      ws.onclose = () => {
        setIsConnected(false);
        setMessages((prev) => [
          ...prev,
          {
            timestamp: new Date().toLocaleTimeString(),
            data: "🔌 Connection closed",
            type: "system",
          },
        ]);
      };

      websocket.current = ws;
    } catch (error: any) {
      setMessages((prev) => [
        ...prev,
        {
          timestamp: new Date().toLocaleTimeString(),
          data: `❌ Failed to connect: ${error.message}`,
          type: "system",
        },
      ]);
    }
  };

  const disconnect = () => {
    if (websocket.current) {
      websocket.current.close();
      websocket.current = null;
    }
  };

  const stringToHex = (str: string): string => {
    let hex = "";
    for (let i = 0; i < str.length; i++) {
      const byte = str.charCodeAt(i).toString(16).padStart(2, "0");
      hex += byte + " ";
      if ((i + 1) % 16 === 0) hex += "\n";
    }
    return hex;
  };

  const isBase64Image = (str: string): boolean => {
    return (
      str.startsWith("data:image/") ||
      (str.length > 100 && /^[A-Za-z0-9+/]+=*$/.test(str.substring(0, 100)))
    );
  };

  const renderMessage = (msg: MessageData, index: number) => {
    if (msg.type === "system") {
      return (
        <Text key={index} style={styles.systemMessage}>
          [{msg.timestamp}] {msg.data}
        </Text>
      );
    }

    // Render stream info if available
    const streamInfoLine = msg.streamInfo ? (
      <Text style={styles.streamInfo}>
        Stream: Frame #{msg.streamInfo.frameId} | Chunk{" "}
        {msg.streamInfo.chunkId + 1}/{msg.streamInfo.chunksTotal} | Progress [
        {frameStates.current.get(msg.streamInfo.frameId)?.receivedChunks.size ||
          0}
        /{msg.streamInfo.chunksTotal}] | Size: {msg.streamInfo.frameSize} bytes
        | Resolution: {msg.streamInfo.width}x{msg.streamInfo.height}
      </Text>
    ) : null;

    switch (viewMode) {
      case "text":
        return (
          <View key={index} style={styles.messageContainer}>
            <Text style={styles.message}>
              [{msg.timestamp}] {msg.data}
            </Text>
            {streamInfoLine}
          </View>
        );

      case "bytes":
        const hexData = msg.binaryData
          ? Array.from(msg.binaryData.slice(0, 256))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(" ")
              .match(/.{1,48}/g)
              ?.join("\n") || ""
          : stringToHex(msg.data.substring(0, 256));
        return (
          <View key={index} style={styles.messageContainer}>
            <Text style={styles.bytesMessage}>
              [{msg.timestamp}]{"\n"}
              {hexData}
              {msg.binaryData && msg.binaryData.length > 256 ? "\n..." : ""}
            </Text>
            {streamInfoLine}
          </View>
        );

      case "image":
        if (isBase64Image(msg.data)) {
          const imageUri = msg.data.startsWith("data:")
            ? msg.data
            : `data:image/png;base64,${msg.data}`;
          return (
            <View key={index} style={styles.imageContainer}>
              <Text style={styles.imageTimestamp}>[{msg.timestamp}]</Text>
              {streamInfoLine}
              <Image
                source={{ uri: imageUri }}
                style={styles.image}
                resizeMode="contain"
              />
            </View>
          );
        } else {
          return (
            <View key={index} style={styles.messageContainer}>
              <Text style={styles.message}>
                [{msg.timestamp}] {msg.data.substring(0, 100)}...
              </Text>
              {streamInfoLine}
            </View>
          );
        }

      case "stream":
        // Show only messages with stream info
        if (!msg.streamInfo) return null;
        return (
          <View key={index} style={styles.messageContainer}>
            <Text style={styles.streamMessage}>[{msg.timestamp}]</Text>
            {streamInfoLine}
          </View>
        );

      default:
        return (
          <View key={index} style={styles.messageContainer}>
            <Text style={styles.message}>
              [{msg.timestamp}] {msg.data}
            </Text>
            {streamInfoLine}
          </View>
        );
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />

      {/* Connection Component */}
      {!isConnected ? (
        <View style={styles.connectionContainer}>
          <Text style={styles.title}>WebSocket Debug Client</Text>

          <View style={styles.inputRow}>
            <Text style={styles.label}>IP:</Text>
            <TextInput
              style={styles.input}
              value={ip}
              onChangeText={setIp}
              placeholder="192.168.1.1"
              autoCapitalize="none"
            />
          </View>

          <View style={styles.inputRow}>
            <Text style={styles.label}>Port:</Text>
            <TextInput
              style={styles.input}
              value={port}
              onChangeText={setPort}
              placeholder="8080"
              keyboardType="numeric"
            />
          </View>

          <TouchableOpacity
            style={styles.connectButton}
            onPress={connectWebSocket}
          >
            <Text style={styles.buttonText}>Connect</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.headerContainer}>
          <View style={styles.headerInfo}>
            <Text style={styles.headerTitle}>🟢 Connected</Text>
            <Text style={styles.headerSubtitle}>
              ws://{ip}:{port}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.disconnectButton}
            onPress={disconnect}
          >
            <Text style={styles.buttonText}>Disconnect</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Live Video Stream */}
      {isConnected && currentFrame && (
        <View style={styles.videoContainer}>
          <View style={styles.videoHeader}>
            <Text style={styles.videoTitle}>📹 Live Stream</Text>
            <Text style={styles.fpsText}>{fps.toFixed(1)} FPS</Text>
          </View>
          <Image
            source={{ uri: currentFrame }}
            style={styles.videoFrame}
            resizeMode="contain"
            onLoad={() => console.log("✅ Image loaded successfully")}
            onError={(error) =>
              console.error("❌ Image load error:", error.nativeEvent.error)
            }
          />
        </View>
      )}

      {/* Show placeholder when no frame yet */}
      {isConnected && !currentFrame && (
        <View style={styles.videoContainer}>
          <View style={styles.videoHeader}>
            <Text style={styles.videoTitle}>📹 Live Stream</Text>
            <Text style={styles.fpsText}>Waiting for frames...</Text>
          </View>
          <View style={styles.videoPlaceholder}>
            <Text style={styles.placeholderText}>
              ⏳ Loading video stream...
            </Text>
          </View>
        </View>
      )}

      {/* Console Component */}
      <View style={styles.consoleContainer}>
        <View style={styles.consoleHeader}>
          <Text style={styles.consoleTitle}>Console</Text>
          <View style={styles.modeSelector}>
            <TouchableOpacity
              style={[
                styles.modeButton,
                viewMode === "text" && styles.modeButtonActive,
              ]}
              onPress={() => changeViewMode("text")}
            >
              <Text
                style={[
                  styles.modeButtonText,
                  viewMode === "text" && styles.modeButtonTextActive,
                ]}
              >
                Text
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.modeButton,
                viewMode === "bytes" && styles.modeButtonActive,
              ]}
              onPress={() => changeViewMode("bytes")}
            >
              <Text
                style={[
                  styles.modeButtonText,
                  viewMode === "bytes" && styles.modeButtonTextActive,
                ]}
              >
                Bytes
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.modeButton,
                viewMode === "stream" && styles.modeButtonActive,
              ]}
              onPress={() => changeViewMode("stream")}
            >
              <Text
                style={[
                  styles.modeButtonText,
                  viewMode === "stream" && styles.modeButtonTextActive,
                ]}
              >
                Stream
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.modeButton,
                viewMode === "image" && styles.modeButtonActive,
              ]}
              onPress={() => changeViewMode("image")}
            >
              <Text
                style={[
                  styles.modeButtonText,
                  viewMode === "image" && styles.modeButtonTextActive,
                ]}
              >
                &lt;/&gt;
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <ScrollView
          ref={scrollViewRef}
          style={styles.consoleScroll}
          contentContainerStyle={styles.consoleContent}
        >
          {messages.map((msg, index) => renderMessage(msg, index))}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1e1e1e",
    paddingTop: 50,
  },
  // Connection Screen Styles
  connectionContainer: {
    backgroundColor: "#2d2d2d",
    padding: 20,
    margin: 10,
    borderRadius: 10,
  },
  title: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 20,
    textAlign: "center",
    color: "#fff",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 15,
  },
  label: {
    width: 60,
    fontSize: 16,
    fontWeight: "600",
    color: "#ddd",
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#444",
    borderRadius: 5,
    padding: 10,
    fontSize: 16,
    backgroundColor: "#1e1e1e",
    color: "#fff",
  },
  connectButton: {
    backgroundColor: "#007AFF",
    padding: 15,
    borderRadius: 5,
    alignItems: "center",
    marginTop: 10,
  },
  // Header Styles (when connected)
  headerContainer: {
    backgroundColor: "#2d2d2d",
    padding: 15,
    margin: 10,
    borderRadius: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerInfo: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#4CAF50",
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 12,
    color: "#888",
    fontFamily: "monospace",
  },
  disconnectButton: {
    backgroundColor: "#FF3B30",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 5,
  },
  buttonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  // Video Stream Styles
  videoContainer: {
    backgroundColor: "#0d1117",
    margin: 10,
    marginTop: 0,
    borderRadius: 10,
    overflow: "hidden",
  },
  videoHeader: {
    backgroundColor: "#161b22",
    padding: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#30363d",
  },
  videoTitle: {
    fontSize: 14,
    fontWeight: "bold",
    color: "#c9d1d9",
  },
  fpsText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#58a6ff",
    fontFamily: "monospace",
  },
  videoFrame: {
    width: "100%",
    height: 250,
    backgroundColor: "#000",
  },
  videoPlaceholder: {
    width: "100%",
    height: 250,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
  placeholderText: {
    color: "#888",
    fontSize: 14,
    fontFamily: "monospace",
  },
  // Console Styles
  consoleContainer: {
    flex: 1,
    backgroundColor: "#0d1117",
    margin: 10,
    marginTop: 0,
    borderRadius: 10,
    overflow: "hidden",
  },
  consoleHeader: {
    backgroundColor: "#161b22",
    padding: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#30363d",
  },
  consoleTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#c9d1d9",
  },
  modeSelector: {
    flexDirection: "row",
    gap: 5,
  },
  modeButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 5,
    backgroundColor: "#21262d",
    borderWidth: 1,
    borderColor: "#30363d",
  },
  modeButtonActive: {
    backgroundColor: "#1f6feb",
    borderColor: "#1f6feb",
  },
  modeButtonText: {
    fontSize: 12,
    color: "#8b949e",
    fontWeight: "600",
  },
  modeButtonTextActive: {
    color: "#fff",
  },
  consoleScroll: {
    flex: 1,
  },
  consoleContent: {
    padding: 10,
  },
  // Message Styles
  messageContainer: {
    marginBottom: 8,
  },
  systemMessage: {
    fontSize: 13,
    marginBottom: 8,
    padding: 8,
    backgroundColor: "#161b22",
    borderRadius: 5,
    borderLeftWidth: 3,
    borderLeftColor: "#ffa657",
    fontFamily: "monospace",
    color: "#ffa657",
  },
  message: {
    fontSize: 13,
    padding: 8,
    backgroundColor: "#0d1117",
    borderRadius: 5,
    borderLeftWidth: 3,
    borderLeftColor: "#58a6ff",
    fontFamily: "monospace",
    color: "#c9d1d9",
  },
  streamInfo: {
    fontSize: 11,
    padding: 6,
    paddingTop: 4,
    backgroundColor: "#1a1f2e",
    borderRadius: 4,
    marginTop: 4,
    color: "#a371f7",
    fontFamily: "monospace",
    fontWeight: "600",
  },
  streamMessage: {
    fontSize: 11,
    padding: 6,
    backgroundColor: "#0d1117",
    borderRadius: 5,
    borderLeftWidth: 3,
    borderLeftColor: "#a371f7",
    fontFamily: "monospace",
    color: "#8b949e",
  },
  bytesMessage: {
    fontSize: 11,
    padding: 8,
    backgroundColor: "#0d1117",
    borderRadius: 5,
    borderLeftWidth: 3,
    borderLeftColor: "#f85149",
    fontFamily: "monospace",
    color: "#7ee787",
  },
  imageContainer: {
    marginBottom: 12,
    padding: 10,
    backgroundColor: "#161b22",
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: "#a371f7",
  },
  imageTimestamp: {
    fontSize: 11,
    color: "#8b949e",
    marginBottom: 8,
    fontFamily: "monospace",
  },
  image: {
    width: "100%",
    height: 200,
    borderRadius: 5,
    backgroundColor: "#0d1117",
  },
});
