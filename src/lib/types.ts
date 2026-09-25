export type RoomStatus = "waiting" | "playing" | "finished";

export interface Room {
  id: string;
  code: string;
  status: RoomStatus;
  host_id: string;
  created_at: string;
}

export interface Player {
  id: string;
  room_id: string;
  user_id: string;
  display_name: string;
  seat: 0 | 1;
  is_host: boolean;
  created_at: string;
  last_seen: string;
}
