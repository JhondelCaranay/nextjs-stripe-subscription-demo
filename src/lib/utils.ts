import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// mongodb+srv://jhondel:<db_password>@cluster0.575z6b7.mongodb.net/
