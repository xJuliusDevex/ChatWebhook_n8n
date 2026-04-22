import { useState, useEffect, useCallback, useRef } from 'react';

export type MessageRole = 'user' | 'ai' | 'system';

export interface ChatMessage {
  role: MessageRole;
  content: string;
  source?: string;
  page?: number;
}

export interface ClientAction {
  tool: string;
  tool_input: any;
}

export interface SearchResult {
  id: string;
  title: string;
}

export const useAgent = (url: string = 'ws://127.0.0.1:8000/ws/chat') => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [connected, setConnected] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const socket = new WebSocket(url);

    socket.onopen = () => {
      setConnected(true);
      console.log('✅ Connected to Agent WebSocket');
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'chat') {
          setMessages((prev) => [...prev, { role: 'ai', content: data.content }]);
          setIsThinking(false);
        } else if (data.type === 'client_action') {
          handleClientAction(data.action);
        }
      } catch (err) {
        console.warn('⚠️ Received non-JSON message:', event.data);
        setMessages((prev) => [...prev, { role: 'ai', content: event.data }]);
        setIsThinking(false);
      }
    };

    socket.onclose = () => {
      setConnected(false);
      console.log('❌ Disconnected from Agent WebSocket');
    };

    socketRef.current = socket;

    return () => {
      socket.close();
    };
  }, [url]);

  const handleClientAction = (action: ClientAction) => {
    console.log('🛠️ Dispatching Client Action:', action);

    switch (action.tool) {
      case 'cli_show_documents':
        // Map inputs to SearchResult objects
        const results = action.tool_input.document_ids.map((id: string, index: number) => ({
          id,
          title: action.tool_input.titles[index] || `Document ${id}`
        }));
        setSearchResults(results);
        setMessages((prev) => [...prev, {
          role: 'system',
          content: `🔍 Encontré ${results.length} documentos relacionados con tu consulta.`
        }]);
        break;
      case 'cli_preview_template':
        setMessages((prev) => [...prev, {
          role: 'system',
          content: `📊 Previsualizando plantilla: ${action.tool_input.template_id}`
        }]);
        break;
      default:
        console.warn('Unknown client tool:', action.tool);
    }
  };

  const sendMessage = useCallback(async (content: string) => {
    setMessages((prev) => [...prev, { role: 'user', content }]);
    setIsThinking(true);

    // Integramos el Webhook de n8n
    try {
      console.log('🔗 ENV VITE_N8N_WEBHOOK_URL:', import.meta.env.VITE_N8N_WEBHOOK_URL);
      const webhookUrl = import.meta.env.VITE_N8N_WEBHOOK_URL;
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ message: content, timestamp: new Date().toISOString() }),
      });

      if (response.ok) {
        console.log('✅ Mensaje enviado al webhook de n8n.');

        // Intentar parsear la respuesta de n8n
        try {
          const data = await response.json();
          console.log('📥 Respuesta desde n8n:', data);

          // Lógica robusta para extraer el texto de la respuesta de n8n sin importar su estructura
          let aiResponse: any;

          if (Array.isArray(data) && data.length > 0) {
            // A veces n8n devuelve un array con el objeto adentro: [{ message: "..." }]
            const first = data[0];
            aiResponse = first?.message || first?.output || first?.text || first;
          } else {
            // Estructura normal: { message: "..." }
            aiResponse = data.message || data.output || data.text || data.response || data;
          }

          // Si por alguna razón n8n lo anidó doblemente (ej. { message: { message: "..." } })
          if (typeof aiResponse === 'object' && aiResponse !== null) {
            aiResponse = aiResponse.message || aiResponse.output || aiResponse.text || JSON.stringify(aiResponse);
          }

          // Seguro final: forzar que sea un string para evitar Error #31 de React
          if (typeof aiResponse !== 'string') {
            aiResponse = String(aiResponse);
          }

          setMessages((prev) => [...prev, { role: 'ai', content: aiResponse }]);
          setIsThinking(false); // Detenemos el estado de carga
        } catch (parseError) {
          console.log('⚠️ n8n no devolvió un JSON válido o devolvió vacío (posible Respond: Immediately)');
        }
      }
    } catch (error) {
      console.error('❌ Error enviando al webhook de n8n:', error);
    }

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ message: content }));
    } else {
      // Si el websocket no está disponible, finalizamos el estado 'isThinking'
      // Esto previene que se quede cargando permanentemente al usar solo n8n
      setIsThinking(false);
      setMessages((prev) => [...prev, {
        role: 'system',
        content: '📡 Acción registrada en n8n correctamente (Modo Webhook).'
      }]);
    }
  }, []);

  const uploadFile = async (file: File) => {
    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', file.name); // Ensure backend has a title

    try {
      const response = await fetch('http://localhost:8000/documents/', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) throw new Error('Upload failed');

      const data = await response.json();
      setMessages((prev) => [...prev, {
        role: 'system',
        content: `✅ Archivo "${file.name}" subido e indexado correctamente.`
      }]);
      return data;
    } catch (err) {
      console.error('Upload Error:', err);
      setMessages((prev) => [...prev, {
        role: 'system',
        content: `❌ Error al subir "${file.name}". Inténtalo de nuevo.`
      }]);
    } finally {
      setIsUploading(false);
    }
  };

  return {
    messages,
    searchResults,
    setMessages,
    sendMessage,
    uploadFile,
    connected,
    isThinking,
    isUploading
  };
};
