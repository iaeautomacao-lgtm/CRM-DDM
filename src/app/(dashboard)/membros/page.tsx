import { redirect } from "next/navigation";

// /membros — renamed to /usuarios (see usuarios/page.tsx). Kept as a
// server-side redirect, not deleted, so old bookmarks/links still
// resolve instead of 404ing.
export default function MembrosPage() {
  redirect("/usuarios");
}
