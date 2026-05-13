import Link from "next/link";

// Static brand element shown at the top of the admin sidebar.
// (The page header / Topbar shows current module via HeaderBrand separately.)
//
// Layout: left-aligned wordmark + subtitle. The X close button sits
// in the sidebar's top-right corner, so left-aligning the brand
// keeps the two from colliding even with the larger text size.
export default function AdminSidebarBrand() {
  return (
    <Link href="/admin" className="block">
      <div className="brand-wordmark text-white text-2xl leading-tight">IKIGAI OS</div>
      <div className="text-[10px] tracking-[2px] text-white/50 uppercase mt-1">
        Admin Console
      </div>
    </Link>
  );
}
