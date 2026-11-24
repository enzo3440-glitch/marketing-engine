import { getRepo } from "@engine/db";
import { PageHeader } from "@/components/ui";
import { MarketingMapBoard } from "./board";

export default async function MapPage() {
  const map = await getRepo().getMap();
  return (
    <>
      <PageHeader title="Marketing Map" description="The strategy board: channels, taglines and creative concepts. Its cards show up on Ideas, ready to make." />
      <MarketingMapBoard initial={map} brainstormEnabled />
    </>
  );
}
