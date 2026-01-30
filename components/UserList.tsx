
import React, { useState } from 'react';
import { Player } from '../types';

interface UserListProps {
  players: Player[];
  currentPlayerId: string;
  onCallUser: (peerId: string) => void;
  onChatUser: (playerId: string) => void;
}

const UserList: React.FC<UserListProps> = ({ players, currentPlayerId, onCallUser, onChatUser }) => {
  const [isOpen, setIsOpen] = useState(false);

  // Filter out self
  const otherPlayers = players.filter(p => p.id !== currentPlayerId);

  return (
    <div className="absolute top-24 left-0 md:left-4 z-40 flex flex-col items-start transition-all duration-300">
        {/* Toggle Button / Header */}
        <button 
            onClick={() => setIsOpen(!isOpen)}
            className="flex items-center gap-2 px-3 py-2 bg-black/40 backdrop-blur-sm border-r-2 border-orange-500 hover:bg-orange-900/20 active:bg-orange-900/40 transition-colors"
        >
            <span className="text-orange-500 pixel-text-shadow text-xs md:text-sm font-bold">
                [{isOpen ? '-' : '+'}] СЕТЬ ({otherPlayers.length})
            </span>
        </button>

      {/* List Container */}
      {isOpen && (
          <div className="mt-2 ml-2 flex flex-col gap-2 bg-black/80 border border-orange-900/50 p-3 rounded-none min-w-[200px] shadow-lg shadow-orange-900/20 animate-fade-in">
            {otherPlayers.length === 0 && (
                <div className="text-orange-800 text-xs pixel-text-shadow animate-pulse py-2 text-center">> ПОИСК СИГНАЛА...</div>
            )}
            
            {otherPlayers.map(p => (
                <div key={p.id} className="flex items-center justify-between gap-3 group border-b border-orange-900/30 pb-2 last:border-0 last:pb-0">
                    <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 ${p.peerId ? 'bg-orange-500 shadow-[0_0_5px_#ffaa00]' : 'bg-gray-700'} rotate-45`}></div>
                        <div className="flex flex-col">
                            <span className="text-orange-400 font-bold text-xs md:text-sm leading-none cursor-default">
                                {p.name.length > 10 ? p.name.substring(0,10) + '..' : p.name}
                            </span>
                            <span className="text-orange-900 text-[8px] pixel-text-shadow">
                                ID: {p.id.substring(0,4)}
                            </span>
                        </div>
                    </div>
                    
                    {/* Actions */}
                    <div className="flex gap-1">
                        <button 
                            onClick={() => onChatUser(p.id)}
                            className="text-orange-600 border border-orange-900 hover:bg-orange-500 hover:text-black px-2 py-1 text-[10px] active:scale-95 transition"
                            title="MSG"
                        >
                            TXT
                        </button>
                        {p.peerId && (
                            <button 
                                onClick={() => onCallUser(p.peerId!)}
                                className="text-orange-500 border border-orange-900 hover:bg-red-500 hover:text-white px-2 py-1 text-[10px] active:scale-95 transition animate-pulse"
                                title="VID"
                            >
                                VID
                            </button>
                        )}
                    </div>
                </div>
            ))}
          </div>
      )}
      <style>{`
        .animate-fade-in {
            animation: fadeIn 0.2s ease-out forwards;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
};

export default UserList;
