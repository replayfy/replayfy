import { useState, useEffect, useRef, Fragment } from "react";
import { rvHue } from "@/routes/recordings/helpers";
import { NavLink, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Popover, Icon, ConfirmDialog } from "@/components/primitives";
import { RvContextMenu, type RvCtxItem } from "@/components/overlays";
import { ShortcutsSheet } from "./ShortcutsSheet";
import type { Workspace } from "@/lib/workspaces";
import { CommandPalette } from "@/components/command";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { NewPlaylist } from "./NewPlaylist";
import { PlaylistsFlyout } from "./PlaylistsFlyout";
import { NAV, NAV_GROUPS, type NavItem, type Playlist } from "./nav.data";
import { prefetchRoute } from "@/routes/routePrefetch";
import { Playlists, Dashboard } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { fmtN } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { ee } from "@ee";

/** Live nav badges. Shares the Overview's counts query via an explicit key, so
 *  the two render off ONE cached request instead of firing it twice. The
 *  endpoint is a single PK read of the workspace counter row. */
type NavCounts = { recordings: number; comments: number };


/* Account-menu external destinations (opened in a new tab). Docs + Support point
   at the live docs site; changelog/status stay placeholders until those exist. */
const DOCS_URL = "https://docs.replayfy.app";
const CHANGELOG_URL = "https://replayfy.app/changelog";
const CONTACT_URL = "https://docs.replayfy.app/support";
const STATUS_URL = "https://status.replayfy.app";


type SidebarProps = {
  collapsed?: boolean;
  /** Mobile only: the sidebar is off-canvas by default and slides in when this
   *  is true (driven by the app-shell hamburger). Ignored on desktop. */
  mobileOpen?: boolean;
  workspaces: Workspace[];
  currentWs: Workspace;
  onSwitchWs: (w: Workspace) => void;
  onNewWs: () => void;
};

export function Sidebar({
  collapsed,
  mobileOpen,
  workspaces,
  currentWs,
  onSwitchWs,
  onNewWs,
}: SidebarProps) {
  const navigate = useNavigate();
  const { user, memberships, workspaceId, logout, can } = useAuth();
  const [pal, setPal] = useState(false);
  // Live sidebar library: the user's most-recent playlists (indexed list on the
  // backend, capped at 3). Cache-keyed to the workspace by useApi; refetch on
  // create so a new playlist appears without a full reload.
  const { data: plData, page: plPage, refetch: refetchPlaylists } = useApi<
    Playlist[]
  >(() => Playlists.list<Playlist[]>({ limit: 3 }), []);
  const playlists = plData ?? [];
  // Live badge counts. `key` is shared with the Overview's counts read so both
  // resolve from one cached request rather than each firing their own.
  const { data: counts } = useApi<NavCounts>(
    () => Dashboard.counts<NavCounts>(),
    [],
    { key: "dashboard-counts" },
  );
  /** The badge for a nav item, or null when it doesn't carry one / isn't loaded
   *  yet — so a badge never flashes a stale or fabricated number. */
  const navCount = (id: string): number | null => {
    if (!counts) return null;
    if (id === "recordings") return counts.recordings;
    if (id === "comments") return counts.comments;
    return null;
  };
  // The right-clicked nav row is carried in state so the menu acts on THAT item
  // rather than on whichever one happens to be active.
  const [navCtx, setNavCtx] = useState<{
    x: number;
    y: number;
    n: NavItem;
  } | null>(null);
  // Right-clicked playlist row (its own menu: view recordings / delete), plus
  // the playlist pending a delete confirmation and the in-flight flag.
  const [plCtx, setPlCtx] = useState<{
    x: number;
    y: number;
    p: Playlist;
  } | null>(null);
  const [plDelete, setPlDelete] = useState<Playlist | null>(null);
  const [plDeleting, setPlDeleting] = useState(false);
  const doDeletePlaylist = async () => {
    if (!plDelete) return;
    setPlDeleting(true);
    try {
      await Playlists.remove(plDelete.id);
      toast.success(`Deleted "${plDelete.title}"`);
      refetchPlaylists();
      setPlDelete(null);
    } catch (e) {
      toast.error(
        "Couldn't delete playlist: " +
          (e instanceof Error ? e.message : "error"),
      );
    } finally {
      setPlDeleting(false);
    }
  };
  /** Right-click menu for a nav row. The two object-list rows offer their real
   *  create routes (same destinations as the N-F / N-C shortcuts above);
   *  everything else just yields its own link. */
  const navCtxItems = (n: NavItem): RvCtxItem[] => {
    if (n.id === "funnels")
      return [
        {
          label: "View all funnels",
          icon: "funnel",
          onClick: () => navigate("/funnels"),
        },
        {
          label: "Create new funnel",
          icon: "plus",
          onClick: () => navigate("/funnels/new"),
        },
      ];
    if (n.id === "cohorts")
      return [
        {
          label: "View all cohorts",
          icon: "cohorts",
          onClick: () => navigate("/cohorts"),
        },
        {
          label: "Create new cohort",
          icon: "plus",
          onClick: () => navigate("/cohorts?new=1"),
        },
      ];
    if (n.id === "settings")
      return [
        {
          label: "Open settings",
          icon: "settings",
          onClick: () => navigate("/settings"),
        },
        {
          label: "Team",
          icon: "users",
          onClick: () => navigate("/settings/team"),
        },
        // Billing is Enterprise Edition — omit the shortcut in the open-source
        // build, where /settings/billing has no tab.
        ...(ee.hasBilling
          ? [
              {
                label: "Billing",
                icon: "doc",
                onClick: () => navigate("/settings/billing"),
              },
            ]
          : []),
      ];
    return [
      {
        label: "Copy link",
        icon: "link",
        onClick: () => {
          // Optional-chaining short-circuits the whole chain on a browser with
          // no clipboard API, so the .then/.catch are only reached when it ran.
          void navigator.clipboard
            ?.writeText(window.location.origin + "/" + n.id)
            .then(() => toast.success("Link copied"))
            .catch(() => toast.error("Couldn't copy link"));
        },
      },
    ];
  };
  const [newPl, setNewPl] = useState(false);
  const [plAll, setPlAll] = useState(false);
  /** Viewport anchor for the account menu, or null when closed. Set from the
   *  chip's own rect on click; RvContextMenu flips it upward on its own since
   *  the footer sits at the bottom of the viewport. */
  const [acctAt, setAcctAt] = useState<{ x: number; y: number } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Wall-clock of the last account-menu close, so a chip click that JUST closed
   *  the menu (via RvContextMenu's outside-mousedown, which fires first on the
   *  same click) doesn't immediately reopen it — makes the chip a real toggle. */
  const acctClosedAt = useRef(0);
  const WS = workspaces;
  const cur = currentWs;
  const role =
    memberships.find((m) => m.workspaceId === workspaceId)?.role ?? "MEMBER";
  const roleLabel = role.charAt(0) + role.slice(1).toLowerCase();
  const displayName = user?.name || user?.email || "You";
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPal((p) => !p);
      }
      // New playlist is the "N then P" sequence (below), consistent with New
      // funnel / cohort / alert. The old ⌘⇧P binding was removed — the browser
      // treats ⌘⇧P as a print/private-window combo and it fell through to that.
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);
  // "Create" sequence shortcuts (keyboard-first): press N, then the object key —
  // N F = new funnel, N C = new cohort, N P = new playlist, N A = new alert.
  // Armed for ~1.4s after N; ignored while typing in a field.
  useEffect(() => {
    let armed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = () => {
      armed = false;
      if (timer) clearTimeout(timer);
    };
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (!armed) {
        if (key === "n") {
          armed = true;
          timer = setTimeout(disarm, 1400);
        }
        return;
      }
      disarm();
      if (key === "f") {
        e.preventDefault();
        navigate("/funnels/new");
      } else if (key === "c") {
        e.preventDefault();
        navigate("/cohorts?new=1");
      } else if (key === "p") {
        e.preventDefault();
        setNewPl(true);
      } else if (key === "a") {
        e.preventDefault();
        navigate("/alerts?new=1");
      }
    };
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("keydown", k);
      disarm();
    };
  }, [navigate]);
  // Workspace-switcher shortcuts — the hints the menu shows are real:
  // ⌘1–⌘9 jump straight to a workspace, ⌥⇧Q signs out.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key >= "1" &&
        e.key <= "9"
      ) {
        const w = WS[Number(e.key) - 1];
        if (w) {
          e.preventDefault();
          onSwitchWs && onSwitchWs(w);
        }
      }
      if (
        e.altKey &&
        e.shiftKey &&
        (e.code === "KeyQ" || e.key === "Q" || e.key === "q")
      ) {
        e.preventDefault();
        void logout().then(() => navigate("/login"));
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [WS, onSwitchWs, logout, navigate]);
  const wsMenu = ({ close }: { close: () => void }) => (
    <WorkspaceMenu
      ws={WS}
      cur={cur}
      email={user?.email}
      onSwitch={(w) => {
        onSwitchWs && onSwitchWs(w);
        close();
      }}
      onNew={() => {
        close();
        onNewWs && onNewWs();
      }}
      onSettings={() => {
        navigate("/settings");
        close();
      }}
      onTeam={() => {
        navigate("/settings/team");
        close();
      }}
      onSignOut={async () => {
        close();
        await logout();
        navigate("/login");
      }}
    />
  );
  return (
    <aside className={`side ${collapsed ? "collapsed" : ""} ${mobileOpen ? "side-m-open" : ""}`}>
      <div className="side-top">
        <Popover
          align="left"
          width={272}
          trigger={
            <button className="ws-trigger">
              <span className="ws-mark" style={{ background: cur.c }}>
                {cur.name[0]}
              </span>
              <span className="ws-name">{cur.name.replace(/,.*$/, "")}</span>
              <Icon name="chev" size={13} className="ws-c" style={{ color: "var(--t3)" }} />
            </button>
          }
        >
          {wsMenu}
        </Popover>
        <button
          className="side-search"
          title="Search ⌘K"
          onClick={() => setPal(true)}
        >
          <Icon name="search" size={15} />
        </button>
      </div>
      <nav className="nav">
        {/* Sectioned nav. Settings is deliberately absent — it lives in the
            account menu (bottom chip) + workspace switcher. A group's `.nav-h`
            label auto-hides when the rail is collapsed. */}
        {NAV_GROUPS.map((g, gi) => (
          <Fragment key={gi}>
            {g.label && (
              <>
                <div className="nav-gap" />
                <div className="nav-h">{g.label}</div>
              </>
            )}
            {g.items.map((n) => (
              <NavLink
                key={n.id}
                to={"/" + n.id}
                className={({ isActive }) => (isActive ? "on" : "")}
                // aria-label (not title) is the accessible name when collapsed —
                // and it avoids the browser's slow native title tooltip so the
                // only tooltip is the instant styled one (.side.collapsed .nav a
                // ::after reads this via attr(aria-label)).
                aria-label={n.label}
                // Warm the route's lazy chunk on intent (hover / keyboard focus),
                // so the click lands on an already-cached chunk and skips the
                // generic <Suspense> skeleton — straight to the page's own.
                onMouseEnter={() => prefetchRoute(n.id)}
                onFocus={() => prefetchRoute(n.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setNavCtx({ x: e.clientX, y: e.clientY, n });
                }}
              >
                <Icon name={n.icon} strokeWidth={2.9} />
                <span className="nav-lbl">{n.label}</span>
                {navCount(n.id) !== null && (
                  <span className="cnt">{fmtN(navCount(n.id)!)}</span>
                )}
              </NavLink>
            ))}
          </Fragment>
        ))}
        {!collapsed && (
          <>
            <div className="nav-gap" />
            <div className="nav-h">
              Playlists{" "}
              <button
                className="nav-h-add"
                data-tip="New playlist · N then P"
                aria-label="New playlist"
                onClick={() => setNewPl(true)}
              >
                <Icon name="plus" size={13} />
              </button>
            </div>
            {playlists.map((p) => (
              <NavLink
                key={p.id}
                to={`/recordings?playlist=${p.id}`}
                className="nav-sm"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setPlCtx({ x: e.clientX, y: e.clientY, p });
                }}
              >
                {/* Hashed from the title, NOT random: a playlist's dot has to
                    be the same colour every render, or it reshuffles on each
                    paint and stops being a thing you can find by colour. Same
                    rvHue the avatars use, so the sidebar speaks one palette. */}
                <span className="d" style={{ background: rvHue(p.title) }} />
                {/* Wrapped, not a bare text node: the row is `display:flex`, so
                    loose text becomes an anonymous flex item that
                    `text-overflow` cannot address — a long title just ran off
                    the sidebar's edge. `title` keeps the full name reachable. */}
                <span className="lbl" title={p.title}>
                  {p.title}
                </span>
              </NavLink>
            ))}
            {/* The nav keeps its 3-row shortlist; everything else lives one
                click away in the flyout. Only offered when there IS more. */}
            {plPage?.has_more && (
              <button className="nav-all" onClick={() => setPlAll(true)}>
                {/* An ellipsis sits in the same column as the playlist dots —
                    it IS dots, so it belongs to that column rather than
                    competing with it, and the label stays aligned with the
                    titles above. */}
                <span className="nav-all-ic">
                  <Icon name="more" size={13} />
                </span>
                See all playlists
              </button>
            )}
          </>
        )}
      </nav>
      {navCtx && (
        <RvContextMenu
          x={navCtx.x}
          y={navCtx.y}
          items={navCtxItems(navCtx.n)}
          onClose={() => setNavCtx(null)}
        />
      )}
      {plCtx && (
        <RvContextMenu
          x={plCtx.x}
          y={plCtx.y}
          items={[
            {
              label: "View recordings",
              icon: "rec",
              onClick: () => navigate(`/recordings?playlist=${plCtx.p.id}`),
            },
            {
              label: "Delete playlist",
              icon: "trash",
              danger: true,
              onClick: () => setPlDelete(plCtx.p),
            },
          ]}
          onClose={() => setPlCtx(null)}
        />
      )}
      {plDelete && (
        <ConfirmDialog
          title={`Delete "${plDelete.title}"?`}
          confirmLabel="Delete playlist"
          busy={plDeleting}
          onConfirm={doDeletePlaylist}
          onClose={() => {
            if (!plDeleting) setPlDelete(null);
          }}
        >
          This removes the playlist from your sidebar. The recordings it holds
          aren’t deleted.
        </ConfirmDialog>
      )}
      <PlaylistsFlyout open={plAll} onClose={() => setPlAll(false)} />
      {newPl && (
        <NewPlaylist
          existing={playlists}
          onClose={() => setNewPl(false)}
          onCreate={() => {
            refetchPlaylists();
            setNewPl(false);
          }}
        />
      )}
      <div className="side-foot">
        <button
          className={`acct ${acctAt ? "open" : ""}`}
          title={user?.email ?? displayName}
          onClick={(e) => {
            // Toggle: clicking the chip while the menu is open closes it.
            // RvContextMenu's outside-mousedown already fired on this same click
            // and set acctClosedAt, so we swallow the reopen inside that window.
            if (Date.now() - acctClosedAt.current < 250) return;
            const r = e.currentTarget.getBoundingClientRect();
            // The menu flips up and its bottom lands at this y, so the offset IS
            // the gap above the chip. 6px read as flush against the highlighted
            // chip; 14px gives it clear separation, a floating menu with room.
            setAcctAt({ x: r.left, y: r.top - 14 });
          }}
        >
          <span className="acct-av">
            {displayName[0].toUpperCase()}
            <i className="acct-dot" />
          </span>
          <span className="acct-id">
            <span className="acct-nm">{displayName}</span>
            <span className="acct-role">{roleLabel}</span>
          </span>
          <svg className="acct-more" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="12" cy="5" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="19" r="1.6" />
          </svg>
        </button>
      </div>
      {acctAt && (
        <RvContextMenu
          x={acctAt.x}
          y={acctAt.y}
          className="rv-ctx-acct"
          items={[
            {
              label: "Settings",
              icon: "settings",
              onClick: () => navigate("/settings"),
            },
            {
              label: "Docs",
              icon: "doc",
              onClick: () => window.open(DOCS_URL, "_blank", "noopener"),
            },
            {
              label: "Changelog",
              icon: "sparkle",
              onClick: () => window.open(CHANGELOG_URL, "_blank", "noopener"),
            },
            {
              label: "Support",
              icon: "comment",
              onClick: () => window.open(CONTACT_URL, "_blank", "noopener"),
            },
            {
              label: "Status page",
              icon: "activity",
              onClick: () => window.open(STATUS_URL, "_blank", "noopener"),
            },
            {
              label: "Keyboard shortcuts",
              icon: "kbd",
              onClick: () => setShortcutsOpen(true),
            },
          ]}
          onClose={() => {
            setAcctAt(null);
            acctClosedAt.current = Date.now();
          }}
        />
      )}
      {pal && (
        <CommandPalette
          onClose={() => setPal(false)}
          onNewPlaylist={() => {
            setPal(false);
            setNewPl(true);
          }}
          onShortcuts={() => {
            setPal(false);
            setShortcutsOpen(true);
          }}
        />
      )}
      {shortcutsOpen && (
        <ShortcutsSheet onClose={() => setShortcutsOpen(false)} />
      )}
    </aside>
  );
}
