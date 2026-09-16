import { useNavigate } from "react-router-dom";
import { FunnelsIndex } from "./index/FunnelsIndex";

type FunnelsProps = { empty?: boolean };

/** /funnels — the funnels index. The illustrated empty state is decided inside
 *  FunnelsIndex (it owns the list fetch), so it shows on a genuinely empty
 *  workspace — the router never passes `empty`, matching the other screens.
 *  Opening a funnel routes to /funnels/:funnelId by its real backend id. */
export function Funnels({ empty }: FunnelsProps) {
  const navigate = useNavigate();
  return (
    <FunnelsIndex
      empty={empty}
      onOpen={(f) => navigate("/funnels/" + f.id)}
      onNew={() => navigate("/funnels/new")}
    />
  );
}
