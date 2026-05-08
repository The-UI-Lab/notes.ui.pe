export interface Note {
  id: string;
  body: string;
  images: string[]; // base64 data URLs stored in localStorage
  createdAt: number;
  updatedAt: number;
}
