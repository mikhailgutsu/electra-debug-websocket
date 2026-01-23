import { StatusBar } from "expo-status-bar";
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
} from "react-native";
import { useState, useRef } from "react";

export default function App() {
  const [ip, setIp] = useState("192.168.1.1");
  const [port, setPort] = useState("8080");
  const [messages, setMessages] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const websocket = useRef<WebSocket | null>(null);

  const connectWebSocket = () => {
    if (websocket.current) {
      websocket.current.close();
    }

    const wsUrl = `ws://${ip}:${port}`;
    setMessages([`Connecting to ${wsUrl}...`]);

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setIsConnected(true);
        setMessages((prev) => [...prev, `✅ Connected to ${wsUrl}`]);
      };

      ws.onmessage = (event) => {
        const timestamp = new Date().toLocaleTimeString();
        setMessages((prev) => [...prev, `[${timestamp}] ${event.data}`]);
      };

      ws.onerror = (error) => {
        setMessages((prev) => [
          ...prev,
          `❌ Error: ${error.message || "Connection error"}`,
        ]);
      };

      ws.onclose = () => {
        setIsConnected(false);
        setMessages((prev) => [...prev, "🔌 Connection closed"]);
      };

      websocket.current = ws;
    } catch (error: any) {
      setMessages((prev) => [
        ...prev,
        `❌ Failed to connect: ${error.message}`,
      ]);
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

      <View style={styles.inputContainer}>
        <Text style={styles.title}>WebSocket Debug Client</Text>

        <View style={styles.inputRow}>
          <Text style={styles.label}>IP:</Text>
          <TextInput
            style={styles.input}
            value={ip}
            onChangeText={setIp}
            placeholder="192.168.1.1"
            autoCapitalize="none"
            editable={!isConnected}
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
            editable={!isConnected}
          />
        </View>

        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.button, isConnected && styles.buttonDisabled]}
            onPress={connectWebSocket}
            disabled={isConnected}
          >
            <Text style={styles.buttonText}>OK</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.button,
              styles.disconnectButton,
              !isConnected && styles.buttonDisabled,
            ]}
            onPress={disconnect}
            disabled={!isConnected}
          >
            <Text style={styles.buttonText}>Disconnect</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.statusContainer}>
          <Text
            style={[styles.statusText, isConnected && styles.statusConnected]}
          >
            {isConnected ? "🟢 Connected" : "🔴 Disconnected"}
          </Text>
        </View>
      </View>

      <View style={styles.messagesContainer}>
        <Text style={styles.messagesTitle}>Messages:</Text>
        <ScrollView
          style={styles.messagesScroll}
          contentContainerStyle={styles.messagesContent}
        >
          {messages.map((msg, index) => (
            <Text key={index} style={styles.message}>
              {msg}
            </Text>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    paddingTop: 50,
  },
  inputContainer: {
    backgroundColor: "#fff",
    padding: 20,
    margin: 10,
    borderRadius: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  title: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 20,
    textAlign: "center",
    color: "#333",
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
    color: "#333",
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 5,
    padding: 10,
    fontSize: 16,
    backgroundColor: "#fff",
  },
  buttonRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
  },
  button: {
    flex: 1,
    backgroundColor: "#007AFF",
    padding: 15,
    borderRadius: 5,
    alignItems: "center",
    marginHorizontal: 5,
  },
  disconnectButton: {
    backgroundColor: "#FF3B30",
  },
  buttonDisabled: {
    backgroundColor: "#ccc",
    opacity: 0.6,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  statusContainer: {
    marginTop: 15,
    alignItems: "center",
  },
  statusText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#FF3B30",
  },
  statusConnected: {
    color: "#34C759",
  },
  messagesContainer: {
    flex: 1,
    backgroundColor: "#fff",
    margin: 10,
    marginTop: 0,
    borderRadius: 10,
    padding: 15,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  messagesTitle: {
    fontSize: 18,
    fontWeight: "bold",
    marginBottom: 10,
    color: "#333",
  },
  messagesScroll: {
    flex: 1,
  },
  messagesContent: {
    paddingBottom: 10,
  },
  message: {
    fontSize: 14,
    marginBottom: 8,
    padding: 8,
    backgroundColor: "#f9f9f9",
    borderRadius: 5,
    borderLeftWidth: 3,
    borderLeftColor: "#007AFF",
    fontFamily: "monospace",
  },
});
