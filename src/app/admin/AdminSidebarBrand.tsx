import Link from "next/link";

// Static brand element shown at the top of the admin sidebar.
// (The page header / Topbar shows current module via HeaderBrand separately.)
//
// Per user feedback: wordmark sits larger + centered. Sidebar width is
// 16rem (w-64) so text-2xl reads as a proper masthead without
// overflowing the column. Subtitle stays small caps for hierarchy.
export default function AdminSidebarBrand() {
  return (
    <Link href="/admin" className="block text-center">
      <div className="brand-wordmark text-white text-2xl leading-tight">IKIGAI OS</div>
      <div className="text-[10px] tracking-[2px] text-white/50 uppercase mt-1">
        Admin Console
      </div>
    </Link>
  );
}
