export interface Line {
  tool: string;
  points: number[];
  color: string;
  strokeWidth: number;
}

export interface DrawingData {
  roomCode: string;
  line: Line;
}
