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

type ViewMode = "text" | "bytes" | "image";

interface MessageData {
  timestamp: string;
  data: string;
  type: "system" | "data";
}

export default function App() {
  const [ip, setIp] = useState("192.168.1.1");
  const [port, setPort] = useState("8080");
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("text");
  const websocket = useRef<WebSocket | null>(null);
  const scrollViewRef = useRef<ScrollView>(null);

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

      ws.onopen = () => {
        setIsConnected(true);
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
        setMessages((prev) => [
          ...prev,
          {
            timestamp,
            data: event.data,
            type: "data",
          },
        ]);
      };

      ws.onerror = (error) => {
        setMessages((prev) => [
          ...prev,
          {
            timestamp: new Date().toLocaleTimeString(),
            data: `❌ Error: ${error.message || "Connection error"}`,
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

    switch (viewMode) {
      case "text":
        return (
          <Text key={index} style={styles.message}>
            [{msg.timestamp}] {msg.data}
          </Text>
        );

      case "bytes":
        return (
          <Text key={index} style={styles.bytesMessage}>
            [{msg.timestamp}]{"\n"}
            {stringToHex(msg.data)}
          </Text>
        );

      case "image":
        if (isBase64Image(msg.data)) {
          const imageUri = msg.data.startsWith("data:")
            ? msg.data
            : `data:image/png;base64,${msg.data}`;
          return (
            <View key={index} style={styles.imageContainer}>
              <Text style={styles.imageTimestamp}>[{msg.timestamp}]</Text>
              <Image
                source={{ uri: imageUri }}
                style={styles.image}
                resizeMode="contain"
              />
            </View>
          );
        } else {
          return (
            <Text key={index} style={styles.message}>
              [{msg.timestamp}] {msg.data.substring(0, 100)}...
            </Text>
          );
        }

      default:
        return (
          <Text key={index} style={styles.message}>
            [{msg.timestamp}] {msg.data}
          </Text>
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
    marginBottom: 8,
    padding: 8,
    backgroundColor: "#0d1117",
    borderRadius: 5,
    borderLeftWidth: 3,
    borderLeftColor: "#58a6ff",
    fontFamily: "monospace",
    color: "#c9d1d9",
  },
  bytesMessage: {
    fontSize: 11,
    marginBottom: 8,
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
