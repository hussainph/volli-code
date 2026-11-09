import type * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AddCircleIcon as AddCircleGlyph,
  Alert02Icon as Alert02Glyph,
  ArchiveIcon as ArchiveGlyph,
  ArrowDown01Icon as ArrowDown01Glyph,
  ArrowDown02Icon as ArrowDown02Glyph,
  ArrowExpand01Icon as ArrowExpand01Glyph,
  ArrowLeft01Icon as ArrowLeft01Glyph,
  ArrowLeft02Icon as ArrowLeft02Glyph,
  ArrowLeftRightIcon as ArrowLeftRightGlyph,
  ArrowReloadHorizontalIcon as ArrowReloadHorizontalGlyph,
  ArrowRight01Icon as ArrowRight01Glyph,
  ArrowRight02Icon as ArrowRight02Glyph,
  ArrowShrink01Icon as ArrowShrink01Glyph,
  ArrowShrink02Icon as ArrowShrink02Glyph,
  ArrowTurnBackwardIcon as ArrowTurnBackwardGlyph,
  ArrowTurnDownIcon as ArrowTurnDownGlyph,
  ArrowUp01Icon as ArrowUp01Glyph,
  ArrowUp02Icon as ArrowUp02Glyph,
  Asterisk02Icon as Asterisk02Glyph,
  AtIcon as AtGlyph,
  Attachment01Icon as Attachment01Glyph,
  BookOpen01Icon as BookOpen01Glyph,
  BrowserIcon as BrowserGlyph,
  Building03Icon as Building03Glyph,
  Cancel01Icon as Cancel01Glyph,
  CancelCircleIcon as CancelCircleGlyph,
  CancelSquareIcon as CancelSquareGlyph,
  ChartHistogramIcon as ChartHistogramGlyph,
  ChartLineData01Icon as ChartLineData01Glyph,
  ChartRingIcon as ChartRingGlyph,
  CheckmarkBadge01Icon as CheckmarkBadge01Glyph,
  CheckmarkCircle02Icon as CheckmarkCircle02Glyph,
  CircleIcon as CircleGlyph,
  CleanIcon as CleanGlyph,
  Clock01Icon as Clock01Glyph,
  CloudIcon as CloudGlyph,
  CloudOffIcon as CloudOffGlyph,
  CloudDownloadIcon as CloudDownloadGlyph,
  CloudUploadIcon as CloudUploadGlyph,
  CodeIcon as CodeGlyph,
  ColumnInsertIcon as ColumnInsertGlyph,
  CommandIcon as CommandGlyph,
  ComputerIcon as ComputerGlyph,
  ComputerDesk01Icon as ComputerDesk01Glyph,
  ComputerTerminal01Icon as ComputerTerminal01Glyph,
  ContrastIcon as ContrastGlyph,
  Copy01Icon as Copy01Glyph,
  CpuIcon as CpuGlyph,
  Cursor01Icon as Cursor01Glyph,
  DashboardSpeed01Icon as DashboardSpeed01Glyph,
  DashedLineCircleIcon as DashedLineCircleGlyph,
  DatabaseIcon as DatabaseGlyph,
  Delete02Icon as Delete02Glyph,
  Directions01Icon as Directions01Glyph,
  DollarCircleIcon as DollarCircleGlyph,
  Download01Icon as Download01Glyph,
  DragDropVerticalIcon as DragDropVerticalGlyph,
  File01Icon as File01Glyph,
  FileAddIcon as FileAddGlyph,
  FileScriptIcon as FileScriptGlyph,
  FileSearchIcon as FileSearchGlyph,
  FileZipIcon as FileZipGlyph,
  Files01Icon as Files01Glyph,
  Film01Icon as Film01Glyph,
  FilterHorizontalIcon as FilterHorizontalGlyph,
  Flag02Icon as Flag02Glyph,
  Flag03Icon as Flag03Glyph,
  FlashIcon as FlashGlyph,
  FlashOffIcon as FlashOffGlyph,
  Folder01Icon as Folder01Glyph,
  FolderAddIcon as FolderAddGlyph,
  FolderOpenIcon as FolderOpenGlyph,
  FoldersIcon as FoldersGlyph,
  GitBranchIcon as GitBranchGlyph,
  GitCommitIcon as GitCommitGlyph,
  GitCompareIcon as GitCompareGlyph,
  GitMergeIcon as GitMergeGlyph,
  GitPullRequestIcon as GitPullRequestGlyph,
  Globe02Icon as Globe02Glyph,
  GridIcon as GridGlyph,
  HandIcon as HandGlyph,
  HardDriveIcon as HardDriveGlyph,
  HelpCircleIcon as HelpCircleGlyph,
  HexagonIcon as HexagonGlyph,
  HierarchySquare02Icon as HierarchySquare02Glyph,
  Home01Icon as Home01Glyph,
  Image01Icon as Image01Glyph,
  InboxIcon as InboxGlyph,
  InformationCircleIcon as InformationCircleGlyph,
  Invoice01Icon as Invoice01Glyph,
  KanbanIcon as KanbanGlyph,
  Key01Icon as Key01Glyph,
  LabsIcon as LabsGlyph,
  LaptopIcon as LaptopGlyph,
  Layers01Icon as Layers01Glyph,
  LayoutTwoColumnIcon as LayoutTwoColumnGlyph,
  LeftToRightListBulletIcon as LeftToRightListBulletGlyph,
  LeftToRightListNumberIcon as LeftToRightListNumberGlyph,
  Unlink01Icon as Unlink01Glyph,
  LinkSquare02Icon as LinkSquare02Glyph,
  Loading03Icon as Loading03Glyph,
  LockKeyIcon as LockKeyGlyph,
  Login02Icon as Login02Glyph,
  Logout02Icon as Logout02Glyph,
  MagicWand01Icon as MagicWand01Glyph,
  Mail01Icon as Mail01Glyph,
  MailOpen01Icon as MailOpen01Glyph,
  MenuSquareIcon as MenuSquareGlyph,
  Message01Icon as Message01Glyph,
  Message02Icon as Message02Glyph,
  MessageMultiple01Icon as MessageMultiple01Glyph,
  MinimizeScreenIcon as MinimizeScreenGlyph,
  MinusSignIcon as MinusSignGlyph,
  MinusSignCircleIcon as MinusSignCircleGlyph,
  MonitorSmartphoneIcon as MonitorSmartphoneGlyph,
  Moon02Icon as Moon02Glyph,
  MoonCloudIcon as MoonCloudGlyph,
  MoreHorizontalIcon as MoreHorizontalGlyph,
  MouseLeftClick01Icon as MouseLeftClick01Glyph,
  News01Icon as News01Glyph,
  Notification03Icon as Notification03Glyph,
  NotificationOff02Icon as NotificationOff02Glyph,
  PackageIcon as PackageGlyph,
  PaintBoardIcon as PaintBoardGlyph,
  PauseIcon as PauseGlyph,
  PauseCircleIcon as PauseCircleGlyph,
  PencilEdit01Icon as PencilEdit01Glyph,
  PinIcon as PinGlyph,
  PinOffIcon as PinOffGlyph,
  PlayIcon as PlayGlyph,
  PlayCircleIcon as PlayCircleGlyph,
  Plug01Icon as Plug01Glyph,
  PlugSocketIcon as PlugSocketGlyph,
  PlusSignIcon as PlusSignGlyph,
  Queue01Icon as Queue01Glyph,
  RefreshIcon as RefreshGlyph,
  RepeatIcon as RepeatGlyph,
  Robot01Icon as Robot01Glyph,
  RowInsertIcon as RowInsertGlyph,
  Search01Icon as Search01Glyph,
  SearchList01Icon as SearchList01Glyph,
  SentIcon as SentGlyph,
  Settings02Icon as Settings02Glyph,
  Share08Icon as Share08Glyph,
  Shield01Icon as Shield01Glyph,
  SidebarLeftIcon as SidebarLeftGlyph,
  SignalFull01Icon as SignalFull01Glyph,
  SignalLow01Icon as SignalLow01Glyph,
  SignalMedium01Icon as SignalMedium01Glyph,
  SkullIcon as SkullGlyph,
  SlidersHorizontalIcon as SlidersHorizontalGlyph,
  SlidersVerticalIcon as SlidersVerticalGlyph,
  Sorting01Icon as Sorting01Glyph,
  SparklesIcon as SparklesGlyph,
  SquareIcon as SquareGlyph,
  StopIcon as StopGlyph,
  StopCircleIcon as StopCircleGlyph,
  Structure03Icon as Structure03Glyph,
  Sun01Icon as Sun01Glyph,
  Tag01Icon as Tag01Glyph,
  Task01Icon as Task01Glyph,
  Tick02Icon as Tick02Glyph,
  Ticket01Icon as Ticket01Glyph,
  UnavailableIcon as UnavailableGlyph,
  UndoIcon as UndoGlyph,
  UnfoldMoreIcon as UnfoldMoreGlyph,
  UserCircleIcon as UserCircleGlyph,
  UserGroupIcon as UserGroupGlyph,
  ViewIcon as ViewGlyph,
  WifiOff01Icon as WifiOff01Glyph,
  Wrench01Icon as Wrench01Glyph,
} from "@hugeicons/core-free-icons";

import "./icon.css";

/** App concepts, not vendor names. Only the MIT free Stroke Rounded set belongs here. */
const glyphs = {
  account: UserCircleGlyph,
  add: PlusSignGlyph,
  addCircle: AddCircleGlyph,
  addColumn: ColumnInsertGlyph,
  addFile: FileAddGlyph,
  addFolder: FolderAddGlyph,
  addRow: RowInsertGlyph,
  adjust: SlidersVerticalGlyph,
  agent: Robot01Glyph,
  archive: ArchiveGlyph,
  archiveFile: FileZipGlyph,
  arrowDown: ArrowDown02Glyph,
  arrowLeft: ArrowLeft02Glyph,
  arrowRight: ArrowRight02Glyph,
  article: News01Glyph,
  attachment: Attachment01Glyph,
  automation: FlashGlyph,
  automationOff: FlashOffGlyph,
  barChart: ChartHistogramGlyph,
  blocked: UnavailableGlyph,
  board: KanbanGlyph,
  branch: GitBranchGlyph,
  browser: BrowserGlyph,
  chat: Message01Glyph,
  chatPending: Message02Glyph,
  check: Tick02Glyph,
  checklist: Task01Glyph,
  chevronDown: ArrowDown01Glyph,
  chevronLeft: ArrowLeft01Glyph,
  chevronRight: ArrowRight01Glyph,
  chevronUp: ArrowUp01Glyph,
  circle: CircleGlyph,
  clean: CleanGlyph,
  click: MouseLeftClick01Glyph,
  clock: Clock01Glyph,
  close: Cancel01Glyph,
  closeSquare: CancelSquareGlyph,
  cloud: CloudGlyph,
  cloudDownload: CloudDownloadGlyph,
  cloudOff: CloudOffGlyph,
  cloudUpload: CloudUploadGlyph,
  code: CodeGlyph,
  codeFile: FileScriptGlyph,
  collapse: ArrowShrink01Glyph,
  collapseVertical: MinimizeScreenGlyph,
  columns: LayoutTwoColumnGlyph,
  command: CommandGlyph,
  commit: GitCommitGlyph,
  compose: PencilEdit01Glyph,
  computer: ComputerGlyph,
  configure: SlidersHorizontalGlyph,
  connected: PlugSocketGlyph,
  contrast: ContrastGlyph,
  conversations: MessageMultiple01Glyph,
  copy: Copy01Glyph,
  cost: DollarCircleGlyph,
  crash: SkullGlyph,
  database: DatabaseGlyph,
  delete: Delete02Glyph,
  devices: MonitorSmartphoneGlyph,
  diff: GitCompareGlyph,
  directions: Directions01Glyph,
  dispatch: SentGlyph,
  document: File01Glyph,
  download: Download01Glyph,
  drag: DragDropVerticalGlyph,
  drive: HardDriveGlyph,
  edit: PencilEdit01Glyph,
  error: CancelCircleGlyph,
  expand: ArrowExpand01Glyph,
  experimental: LabsGlyph,
  external: LinkSquare02Glyph,
  file: File01Glyph,
  files: Files01Glyph,
  filter: FilterHorizontalGlyph,
  findFile: FileSearchGlyph,
  finished: Flag03Glyph,
  flag: Flag02Glyph,
  folder: Folder01Glyph,
  folderOpen: FolderOpenGlyph,
  folders: FoldersGlyph,
  gauge: DashboardSpeed01Glyph,
  globe: Globe02Glyph,
  grid: GridGlyph,
  group: Structure03Glyph,
  guide: BookOpen01Glyph,
  halfCircle: ContrastGlyph,
  hand: HandGlyph,
  help: HelpCircleGlyph,
  hexagon: HexagonGlyph,
  history: UndoGlyph,
  home: Home01Glyph,
  host: ComputerDesk01Glyph,
  image: Image01Glyph,
  inbox: InboxGlyph,
  info: InformationCircleGlyph,
  integration: Plug01Glyph,
  key: Key01Glyph,
  label: Tag01Glyph,
  laptop: LaptopGlyph,
  layers: Layers01Glyph,
  list: LeftToRightListBulletGlyph,
  lock: LockKeyGlyph,
  mail: Mail01Glyph,
  mailOpen: MailOpen01Glyph,
  maximize: ArrowExpand01Glyph,
  mention: AtGlyph,
  merge: GitMergeGlyph,
  minus: MinusSignGlyph,
  monitor: ComputerGlyph,
  moon: Moon02Glyph,
  more: MoreHorizontalGlyph,
  night: MoonCloudGlyph,
  notification: Notification03Glyph,
  notificationOff: NotificationOff02Glyph,
  offline: WifiOff01Glyph,
  openInside: ArrowShrink02Glyph,
  orderedList: LeftToRightListNumberGlyph,
  package: PackageGlyph,
  palette: PaintBoardGlyph,
  pause: PauseGlyph,
  pauseCircle: PauseCircleGlyph,
  pending: DashedLineCircleGlyph,
  pin: PinGlyph,
  play: PlayGlyph,
  playCircle: PlayCircleGlyph,
  pointer: Cursor01Glyph,
  preview: ViewGlyph,
  priorityHigh: SignalFull01Glyph,
  priorityLow: SignalLow01Glyph,
  priorityMedium: SignalMedium01Glyph,
  privacy: Shield01Glyph,
  processor: CpuGlyph,
  pullRequest: GitPullRequestGlyph,
  queue: Queue01Glyph,
  receipt: Invoice01Glyph,
  refresh: RefreshGlyph,
  removeCircle: MinusSignCircleGlyph,
  repeat: RepeatGlyph,
  reply: ArrowTurnBackwardGlyph,
  required: Asterisk02Glyph,
  restoreWindow: ArrowShrink01Glyph,
  return: ArrowTurnDownGlyph,
  rows: MenuSquareGlyph,
  search: Search01Glyph,
  searchList: SearchList01Glyph,
  send: ArrowUp02Glyph,
  settings: Settings02Glyph,
  share: Share08Glyph,
  sidebar: SidebarLeftGlyph,
  signIn: Login02Glyph,
  signOut: Logout02Glyph,
  sort: Sorting01Glyph,
  sparkle: SparklesGlyph,
  spinner: Loading03Glyph,
  splitLayout: LayoutTwoColumnGlyph,
  square: SquareGlyph,
  stop: StopGlyph,
  stopCircle: StopCircleGlyph,
  storage: HardDriveGlyph,
  success: CheckmarkCircle02Glyph,
  sun: Sun01Glyph,
  swap: ArrowLeftRightGlyph,
  sync: ArrowReloadHorizontalGlyph,
  team: UserGroupGlyph,
  terminal: ComputerTerminal01Glyph,
  ticket: Ticket01Glyph,
  tools: Wrench01Glyph,
  tree: HierarchySquare02Glyph,
  trend: ChartLineData01Glyph,
  undo: UndoGlyph,
  unfold: UnfoldMoreGlyph,
  unlink: Unlink01Glyph,
  unpin: PinOffGlyph,
  usage: ChartRingGlyph,
  verified: CheckmarkBadge01Glyph,
  video: Film01Glyph,
  wand: MagicWand01Glyph,
  warning: Alert02Glyph,
  welcome: HandGlyph,
  workspace: Building03Glyph,
};

export type IconName = keyof typeof glyphs;
export type IconProps = Omit<React.SVGProps<SVGSVGElement>, "name" | "strokeWidth" | "children"> & {
  size?: number | string;
  strokeWidth?: number;
  alt?: string;
};
export type IconComponent = React.FunctionComponent<IconProps>;

/** A colour-inheriting drawing. The caller retains all labelling and visibility decisions. */
export function Icon({
  name,
  size = "1em",
  strokeWidth,
  className = "",
  style,
  alt,
  ...props
}: IconProps & { name: IconName }) {
  const small = Number(size) > 0 && Number(size) <= 12;
  const stroke = strokeWidth ?? (small ? 2.25 : undefined);
  return (
    <HugeiconsIcon
      icon={alt ? [["title", { children: alt, key: "icon-title" }], ...glyphs[name]] : glyphs[name]}
      size={size}
      strokeWidth={1.5}
      className={"ui-icon " + className}
      style={
        {
          ...(stroke === undefined ? {} : { "--icon-stroke": stroke }),
          ...style,
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

// Stable components for menus, registries and polymorphic leading slots.
function symbol(name: IconName): IconComponent {
  return function Symbol(props: IconProps) {
    return <Icon name={name} {...props} />;
  };
}

export const AccountIcon = symbol("account");
export const AddIcon = symbol("add");
export const AddCircleIcon = symbol("addCircle");
export const AddColumnIcon = symbol("addColumn");
export const AddFileIcon = symbol("addFile");
export const AddFolderIcon = symbol("addFolder");
export const AddRowIcon = symbol("addRow");
export const AdjustIcon = symbol("adjust");
export const AgentIcon = symbol("agent");
export const ArchiveIcon = symbol("archive");
export const ArchiveFileIcon = symbol("archiveFile");
export const ArrowDownIcon = symbol("arrowDown");
export const ArrowLeftIcon = symbol("arrowLeft");
export const ArrowRightIcon = symbol("arrowRight");
export const ArticleIcon = symbol("article");
export const AttachmentIcon = symbol("attachment");
export const AutomationIcon = symbol("automation");
export const AutomationOffIcon = symbol("automationOff");
export const BarChartIcon = symbol("barChart");
export const BlockedIcon = symbol("blocked");
export const BoardIcon = symbol("board");
export const BranchIcon = symbol("branch");
export const BrowserIcon = symbol("browser");
export const ChatIcon = symbol("chat");
export const ChatPendingIcon = symbol("chatPending");
export const CheckIcon = symbol("check");
export const ChecklistIcon = symbol("checklist");
export const ChevronDownIcon = symbol("chevronDown");
export const ChevronLeftIcon = symbol("chevronLeft");
export const ChevronRightIcon = symbol("chevronRight");
export const ChevronUpIcon = symbol("chevronUp");
export const CircleIcon = symbol("circle");
export const CleanIcon = symbol("clean");
export const ClickIcon = symbol("click");
export const ClockIcon = symbol("clock");
export const CloseIcon = symbol("close");
export const CloseSquareIcon = symbol("closeSquare");
export const CloudIcon = symbol("cloud");
export const CloudDownloadIcon = symbol("cloudDownload");
export const CloudOffIcon = symbol("cloudOff");
export const CloudUploadIcon = symbol("cloudUpload");
export const CodeIcon = symbol("code");
export const CodeFileIcon = symbol("codeFile");
export const CollapseIcon = symbol("collapse");
export const CollapseVerticalIcon = symbol("collapseVertical");
export const ColumnsIcon = symbol("columns");
export const CommandIcon = symbol("command");
export const CommitIcon = symbol("commit");
export const ComposeIcon = symbol("compose");
export const ComputerIcon = symbol("computer");
export const ConfigureIcon = symbol("configure");
export const ConnectedIcon = symbol("connected");
export const ContrastIcon = symbol("contrast");
export const ConversationsIcon = symbol("conversations");
export const CopyIcon = symbol("copy");
export const CostIcon = symbol("cost");
export const CrashIcon = symbol("crash");
export const DatabaseIcon = symbol("database");
export const DeleteIcon = symbol("delete");
export const DevicesIcon = symbol("devices");
export const DiffIcon = symbol("diff");
export const DirectionsIcon = symbol("directions");
export const DispatchIcon = symbol("dispatch");
export const DocumentIcon = symbol("document");
export const DownloadIcon = symbol("download");
export const DragIcon = symbol("drag");
export const DriveIcon = symbol("drive");
export const EditIcon = symbol("edit");
export const ErrorIcon = symbol("error");
export const ExpandIcon = symbol("expand");
export const ExperimentalIcon = symbol("experimental");
export const ExternalIcon = symbol("external");
export const FileIcon = symbol("file");
export const FilesIcon = symbol("files");
export const FilterIcon = symbol("filter");
export const FindFileIcon = symbol("findFile");
export const FinishedIcon = symbol("finished");
export const FlagIcon = symbol("flag");
export const FolderIcon = symbol("folder");
export const FolderOpenIcon = symbol("folderOpen");
export const FoldersIcon = symbol("folders");
export const GaugeIcon = symbol("gauge");
export const GlobeIcon = symbol("globe");
export const GridIcon = symbol("grid");
export const GroupIcon = symbol("group");
export const GuideIcon = symbol("guide");
export const HalfCircleIcon = symbol("halfCircle");
export const HandIcon = symbol("hand");
export const HelpIcon = symbol("help");
export const HexagonIcon = symbol("hexagon");
export const HistoryIcon = symbol("history");
export const HomeIcon = symbol("home");
export const HostIcon = symbol("host");
export const ImageIcon = symbol("image");
export const InboxIcon = symbol("inbox");
export const InfoIcon = symbol("info");
export const IntegrationIcon = symbol("integration");
export const KeyIcon = symbol("key");
export const LabelIcon = symbol("label");
export const LaptopIcon = symbol("laptop");
export const LayersIcon = symbol("layers");
export const ListIcon = symbol("list");
export const LockIcon = symbol("lock");
export const MailIcon = symbol("mail");
export const MailOpenIcon = symbol("mailOpen");
export const MaximizeIcon = symbol("maximize");
export const MentionIcon = symbol("mention");
export const MergeIcon = symbol("merge");
export const MinusIcon = symbol("minus");
export const MonitorIcon = symbol("monitor");
export const MoonIcon = symbol("moon");
export const MoreIcon = symbol("more");
export const NightIcon = symbol("night");
export const NotificationIcon = symbol("notification");
export const NotificationOffIcon = symbol("notificationOff");
export const OfflineIcon = symbol("offline");
export const OpenInsideIcon = symbol("openInside");
export const OrderedListIcon = symbol("orderedList");
export const PackageIcon = symbol("package");
export const PaletteIcon = symbol("palette");
export const PauseIcon = symbol("pause");
export const PauseCircleIcon = symbol("pauseCircle");
export const PendingIcon = symbol("pending");
export const PinIcon = symbol("pin");
export const PlayIcon = symbol("play");
export const PlayCircleIcon = symbol("playCircle");
export const PointerIcon = symbol("pointer");
export const PreviewIcon = symbol("preview");
export const PriorityHighIcon = symbol("priorityHigh");
export const PriorityLowIcon = symbol("priorityLow");
export const PriorityMediumIcon = symbol("priorityMedium");
export const PrivacyIcon = symbol("privacy");
export const ProcessorIcon = symbol("processor");
export const PullRequestIcon = symbol("pullRequest");
export const QueueIcon = symbol("queue");
export const ReceiptIcon = symbol("receipt");
export const RefreshIcon = symbol("refresh");
export const RemoveCircleIcon = symbol("removeCircle");
export const RepeatIcon = symbol("repeat");
export const ReplyIcon = symbol("reply");
export const RequiredIcon = symbol("required");
export const RestoreWindowIcon = symbol("restoreWindow");
export const ReturnIcon = symbol("return");
export const RowsIcon = symbol("rows");
export const SearchIcon = symbol("search");
export const SearchListIcon = symbol("searchList");
export const SendIcon = symbol("send");
export const SettingsIcon = symbol("settings");
export const ShareIcon = symbol("share");
export const SidebarIcon = symbol("sidebar");
export const SignInIcon = symbol("signIn");
export const SignOutIcon = symbol("signOut");
export const SortIcon = symbol("sort");
export const SparkleIcon = symbol("sparkle");
export const SpinnerIcon = symbol("spinner");
export const SplitLayoutIcon = symbol("splitLayout");
export const SquareIcon = symbol("square");
export const StopIcon = symbol("stop");
export const StopCircleIcon = symbol("stopCircle");
export const StorageIcon = symbol("storage");
export const SuccessIcon = symbol("success");
export const SunIcon = symbol("sun");
export const SwapIcon = symbol("swap");
export const SyncIcon = symbol("sync");
export const TeamIcon = symbol("team");
export const TerminalIcon = symbol("terminal");
export const TicketIcon = symbol("ticket");
export const ToolsIcon = symbol("tools");
export const TreeIcon = symbol("tree");
export const TrendIcon = symbol("trend");
export const UndoIcon = symbol("undo");
export const UnfoldIcon = symbol("unfold");
export const UnlinkIcon = symbol("unlink");
export const UnpinIcon = symbol("unpin");
export const UsageIcon = symbol("usage");
export const VerifiedIcon = symbol("verified");
export const VideoIcon = symbol("video");
export const WandIcon = symbol("wand");
export const WarningIcon = symbol("warning");
export const WelcomeIcon = symbol("welcome");
export const WorkspaceIcon = symbol("workspace");
