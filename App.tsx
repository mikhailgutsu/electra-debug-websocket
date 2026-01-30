import { StatusBar } from "expo-status-bar";
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  Image,
} from "react-native";
import { useState, useRef } from "react";

interface StreamInfo {
  frameId: number;
  chunkId: number;
  chunksTotal: number;
  frameSize: number;
  width: number;
  height: number;
  payloadLen: number;
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
  const [isConnected, setIsConnected] = useState(false);
  const [currentFrame, setCurrentFrame] = useState<string | null>(null);
  const [fps, setFps] = useState<number>(0);
  const [connectionStatus, setConnectionStatus] = useState<string>("");

  const websocket = useRef<WebSocket | null>(null);
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

  const connectWebSocket = () => {
    if (websocket.current) {
      websocket.current.close();
    }

    const wsUrl = `ws://${ip}:${port}`;
    setConnectionStatus("Connecting...");

    try {
      const ws = new WebSocket(wsUrl);
      (ws as any).binaryType = "arraybuffer";

      ws.onopen = () => {
        setIsConnected(true);
        fpsCounter.current = { count: 0, lastTime: 0 };
        setFps(0);
        setCurrentFrame(null);
        setConnectionStatus("🟢 Connected");
      };

      ws.onmessage = (event) => {
        const processBuffer = (buffer: ArrayBuffer) => {
          const header = parseMyirHeader(buffer);

          if (header) {
            const HDR_SIZE = 36;
            const payload = new Uint8Array(buffer, HDR_SIZE, header.payloadLen);

            const completeFrame = reassembler.current.push(header, payload);

            if (completeFrame) {
              const now = Date.now();
              if (fpsCounter.current.lastTime === 0) {
                fpsCounter.current.lastTime = now;
              }

              fpsCounter.current.count++;
              const elapsed = now - fpsCounter.current.lastTime;

              if (elapsed >= 1000) {
                const currentFps = (fpsCounter.current.count * 1000) / elapsed;
                setFps(Math.round(currentFps * 10) / 10);
                fpsCounter.current.count = 0;
                fpsCounter.current.lastTime = now;
              }

              const jpegData = completeFrame.getJpegData();
              const base64 = uint8ArrayToBase64(jpegData);
              const imageUri = `data:image/jpeg;base64,${base64}`;
              setCurrentFrame(imageUri);
              setConnectionStatus(
                `🟢 Streaming ${header.width}x${header.height}`,
              );
            }

            reassembler.current.gc();
          }
        };

        if (event.data instanceof ArrayBuffer) {
          processBuffer(event.data);
        } else if (event.data instanceof Blob) {
          event.data.arrayBuffer().then(processBuffer);
        }
      };

      ws.onerror = () => {
        setConnectionStatus("❌ Connection error");
      };

      ws.onclose = () => {
        setIsConnected(false);
        setConnectionStatus("🔌 Disconnected");
      };

      websocket.current = ws;
    } catch (error: any) {
      setConnectionStatus(`❌ Failed: ${error.message}`);
    }
  };

  const disconnect = () => {
    if (websocket.current) {
      websocket.current.close();
      websocket.current = null;
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />

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
            <Text style={styles.fpsText}>{connectionStatus}</Text>
          </View>
          <View style={styles.videoPlaceholder}>
            <Text style={styles.placeholderText}>
              ⏳ Loading video stream...
            </Text>
          </View>
        </View>
      )}
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
    flex: 1,
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
    flex: 1,
    backgroundColor: "#000",
  },
  videoPlaceholder: {
    width: "100%",
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
  placeholderText: {
    color: "#888",
    fontSize: 14,
    fontFamily: "monospace",
  },
});
