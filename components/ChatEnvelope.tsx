import React, { useState, useEffect } from 'react';
import { Player, ChatMessage } from '../types';

interface ChatEnvelopeProps {
  players: Player[];
  messages: ChatMessage[];
  currentPlayerId: string;
  onSendMessage: (text: string, targetId?: string) => void;
  activeTargetId?: string | null;
}

const ChatEnvelope: React.FC<ChatEnvelopeProps> = ({ players, messages, currentPlayerId, onSendMessage, activeTargetId }) => {
  const [internalActiveDm, setInternalActiveDm] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');

  useEffect(() => {
      if (activeTargetId) setInternalActiveDm(activeTargetId);
  }, [activeTargetId]);

  const activeDm = internalActiveDm;
  const activePlayer = activeDm ? players.find(p => p.id === activeDm) : null;
  
  // Last 5 messages only to keep HUD clean
  const visibleMessages = messages.filter(m => {
    if (activeDm) return (m.senderId === currentPlayerId && (m as any).targetId === activeDm) || m.senderId === activeDm;
    return !(m as any).targetId;
  }).slice(-6);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    onSendMessage(inputText, activeDm || undefined);
    setInputText('');
  };

  return (
    <div className="absolute bottom-4 right-4 w-96 flex flex-col items-end pointer-events-auto">
      
      {/* Message Log (Floating text) */}
      <div className="flex flex-col items-end gap-1 mb-2 w-full">
        {visibleMessages.map(msg => (
            <div key={msg.id} className="text-right pixel-text-shadow max-w-full">
                <span className="text-orange-700 text-sm uppercase mr-2">
                    {msg.senderId === currentPlayerId ? 'ВЫ' : msg.senderName}:
                </span>
                <span className={`text-xl ${msg.senderId === currentPlayerId ? 'text-white' : 'text-orange-400'}`}>
                    {msg.text}
                </span>
            </div>
        ))}
      </div>

      {/* Input Line */}
      <form onSubmit={handleSubmit} className="flex gap-2 w-full justify-end items-center bg-gradient-to-l from-orange-900/20 to-transparent p-1">
        <div className="text-orange-500 font-bold pixel-text-shadow">
            {activePlayer ? `@${activePlayer.name}` : 'ВСЕМ'} {'>'}
        </div>
        <input 
            type="text" 
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            className="bg-transparent text-white font-bold text-lg outline-none w-48 text-right placeholder-orange-900/50 pixel-text-shadow"
            placeholder="_"
            autoFocus
        />
      </form>
    </div>
  );
};

export default ChatEnvelope;