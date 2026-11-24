import { requireArea } from "@/lib/auth";

/** Marketing Map and the advanced video tools live here; the rest of the old Content section moved to Ideas, Make, Launch and Results. */
export default async function ContentLayout({ children }: { children: React.ReactNode }) {
  await requireArea("content");
  return <>{children}</>;
}
