import Link from "next/link";
import {
  ArrowDown, ArrowRight, Check, Clock, Eraser, Flower2, Heart, Lock, MessageCircleHeart,
  Mic, MoreHorizontal, ShieldCheck, Sparkles, Sun, UserRoundCheck, Users,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

const float = "shadow-[0_24px_60px_-30px_rgba(80,40,50,0.35)]";

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
      <span className="size-1.5 rounded-full bg-primary ring-4 ring-primary/15" aria-hidden />
      {children}
    </p>
  );
}

function SignInButton({ children = "Discover Keepsake", size = "lg" as const }) {
  return (
    <Button asChild size={size} className={`h-12 rounded-full px-6 text-[15px] ${float}`}>
      <Link href="/login">{children}<ArrowRight /></Link>
    </Button>
  );
}

function VoiceCard() {
  return (
    <Card className={`w-full max-w-sm gap-0 rounded-2xl border-0 py-0 ${float}`}>
      <CardContent className="space-y-5 p-6">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            <span className="size-2 rounded-full bg-success" aria-hidden /> Here with you
          </p>
          <Sun className="size-4 text-primary/70" aria-hidden />
        </div>
        <p className="font-serif text-3xl leading-tight">
          Good morning,<br /><em className="text-primary">Mom.</em>
        </p>
        <div className="flex items-center gap-3 rounded-xl bg-secondary px-4 py-3">
          <Mic className="size-4 text-primary" aria-hidden />
          <p className="flex-1 text-sm text-muted-foreground">&ldquo;Is anyone coming today?&rdquo;</p>
          <div className="flex h-5 items-center gap-0.5" aria-hidden>
            {[40, 75, 55, 100, 65, 85, 45].map((h, i) => (
              <span key={i} className="w-0.5 rounded-full bg-primary/70" style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-xs text-primary"><Sparkles className="size-3.5" aria-hidden /> A gentle answer, from your people</p>
          <p className="font-serif text-xl leading-snug">Your caregiver is coming at 10, and your daughter is bringing dinner at 6.</p>
        </div>
        <Separator />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className="grid size-5 place-items-center rounded-full bg-success/10 text-success"><Check className="size-3" aria-hidden /></span>
            Remembered &amp; family-verified
          </span>
          <MoreHorizontal className="size-4" aria-hidden />
        </div>
      </CardContent>
    </Card>
  );
}

function Chip({ icon: Icon, title, body, className }: { icon: typeof Lock; title: string; body: string; className: string }) {
  return (
    <div className={`absolute hidden items-center gap-3 rounded-xl bg-card/95 px-4 py-3 backdrop-blur sm:flex ${float} ${className}`}>
      <span className="grid size-8 place-items-center rounded-full bg-secondary text-primary"><Icon className="size-4" aria-hidden /></span>
      <span>
        <span className="block text-xs font-semibold">{title}</span>
        <span className="block text-[11px] text-muted-foreground">{body}</span>
      </span>
    </div>
  );
}

const steps = [
  { icon: MessageCircleHeart, title: "Just talk", body: "She asks in her own words, any time of day. No screens to learn, just one big button." },
  { icon: UserRoundCheck, title: "Family checks", body: "Anything new she mentions goes to the family to confirm before it's treated as true." },
  { icon: Sparkles, title: "A gentle answer", body: "Keepsake answers only from what the family verified, and says so kindly when it isn't sure." },
];

const familyTools = [
  { icon: Check, title: "Confirm or fix a detail", body: "Approve what's right. Correct what isn't, and the old version stops being used." },
  { icon: Eraser, title: "Forget, completely", body: "Remove a memory and its words are gone, not just hidden." },
  { icon: Heart, title: "Guide the hard topics", body: "Tell Keepsake how to handle what matters most, in your own words." },
];

const promises = [
  { icon: Lock, title: "Private stays private", body: "What she asks to keep to herself, no one else can see. Caregivers see only what they need for care." },
  { icon: Users, title: "Every memory has a person", body: "Each detail shows who added it and who confirmed it." },
  { icon: ShieldCheck, title: "Forgotten means gone", body: "The activity history records that something changed, never what it said." },
  { icon: Clock, title: "Plans expire on their own", body: "Today's visit doesn't linger into next week. Short-lived details clear themselves." },
];

export default function Landing() {
  return (
    <div className="flex min-h-full flex-col bg-background">
      <header className="border-b">
        <nav className="mx-auto flex h-20 max-w-6xl items-center justify-between px-4 sm:px-6" aria-label="Main">
          <Logo />
          <div className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
            <a href="#how" className="hover:text-foreground">How it works</a>
            <a href="#family" className="hover:text-foreground">For your family</a>
            <a href="#promise" className="hover:text-foreground">Our promise</a>
          </div>
          <Button asChild variant="outline" className="h-11 rounded-full bg-transparent px-5">
            <Link href="/login">Meet Keepsake <ArrowRight /></Link>
          </Button>
        </nav>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-12 pt-14 sm:px-6 lg:grid-cols-[1fr_1.05fr] lg:pt-20">
          <div className="space-y-8">
            <Eyebrow>A little more present, together</Eyebrow>
            <h1 className="font-serif text-6xl leading-[0.95] tracking-tight sm:text-7xl lg:text-[5.5rem]">
              More of the <em className="text-primary">moments</em> that matter.
            </h1>
            <p className="max-w-md text-lg leading-relaxed text-muted-foreground">
              A gentle voice companion that helps keep the details of everyday life close, with the people you trust in control.
            </p>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
              <SignInButton />
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><Heart className="size-4 text-primary" aria-hidden /> Made with families, for families</p>
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-4 text-sm text-muted-foreground">
              <div className="flex -space-x-2" aria-hidden>
                {[["Y", "bg-secondary"], ["F", "bg-[#e7efe8]"], ["C", "bg-[#f3e9dc]"]].map(([l, bg]) => (
                  <Avatar key={l} className="size-8 ring-2 ring-background"><AvatarFallback className={`${bg} font-serif text-foreground`}>{l}</AvatarFallback></Avatar>
                ))}
              </div>
              <span className="text-foreground/80">For the whole circle of care</span>
              <Separator orientation="vertical" className="h-4" />
              <span>You · Family · Care team</span>
            </div>
          </div>

          <div className="relative">
            <div
              className="relative flex min-h-[34rem] items-center justify-center overflow-hidden rounded-[2rem] rounded-tl-[14rem] px-6 py-16 sm:rounded-tl-[22rem]"
              style={{ background: "radial-gradient(120% 90% at 85% 15%, #f4d3db 0%, #f7e3e6 38%, #fbf1ef 70%, #fdf7f4 100%)" }}
            >
              <div className="pointer-events-none absolute -right-16 -top-10 size-72 rounded-full bg-[#eeb8c6]/40 blur-3xl" aria-hidden />
              <div className="pointer-events-none absolute -bottom-20 left-10 size-64 rounded-full bg-[#f6cfd6]/50 blur-3xl" aria-hidden />
              <VoiceCard />
              <Chip icon={Lock} title="Shared with care" body="Only the right people see" className="right-5 top-6" />
              <Chip icon={Users} title="Your family, in the loop" body="Every memory has a person" className="bottom-10 right-5" />
              <p className="absolute bottom-5 left-8 hidden text-[10px] uppercase tracking-[0.3em] text-primary/50 sm:block" aria-hidden>Keep the good close</p>
            </div>
          </div>
        </section>

        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <Separator />
          <div className="flex items-center justify-between py-5 text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            <span className="hidden sm:inline">Gentle by design</span>
            <a href="#how" className="mx-auto flex items-center gap-2 text-xs normal-case tracking-normal text-primary sm:mx-0">
              A calmer kind of remembering <ArrowDown className="size-3.5" aria-hidden />
            </a>
            <span className="hidden sm:inline">Built around trust</span>
          </div>
        </div>

        {/* How it works */}
        <section id="how" className="mx-auto max-w-6xl scroll-mt-8 px-4 py-24 sm:px-6">
          <div className="max-w-2xl space-y-4">
            <Eyebrow>How it works</Eyebrow>
            <h2 className="font-serif text-5xl leading-tight">Ask anything. Hear what&apos;s <em className="text-primary">true</em>.</h2>
            <p className="text-lg text-muted-foreground">Keepsake listens, remembers, and only repeats what the people who love her have confirmed.</p>
          </div>
          <ol className="mt-14 grid gap-6 md:grid-cols-3">
            {steps.map(({ icon: Icon, title, body }, i) => (
              <li key={title}>
                <Card className="h-full gap-4 rounded-2xl border-border/70 p-7 shadow-none">
                  <div className="flex items-center justify-between">
                    <span className="grid size-11 place-items-center rounded-full bg-secondary text-primary"><Icon className="size-5" aria-hidden /></span>
                    <span className="font-serif text-3xl text-primary/30">0{i + 1}</span>
                  </div>
                  <h3 className="font-serif text-2xl">{title}</h3>
                  <p className="text-muted-foreground">{body}</p>
                </Card>
              </li>
            ))}
          </ol>
        </section>

        {/* For your family */}
        <section id="family" className="scroll-mt-8 bg-secondary/50">
          <div className="mx-auto grid max-w-6xl items-center gap-14 px-4 py-24 sm:px-6 lg:grid-cols-2">
            <div className="space-y-8">
              <div className="space-y-4">
                <Eyebrow>For your family</Eyebrow>
                <h2 className="font-serif text-5xl leading-tight">You decide what she <em className="text-primary">remembers</em>.</h2>
                <p className="text-lg text-muted-foreground">One calm place for family and caregivers to look after the details together.</p>
              </div>
              <ul className="space-y-5">
                {familyTools.map(({ icon: Icon, title, body }) => (
                  <li key={title} className="flex gap-4">
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-card text-primary shadow-sm"><Icon className="size-4" aria-hidden /></span>
                    <div><p className="font-medium">{title}</p><p className="text-muted-foreground">{body}</p></div>
                  </li>
                ))}
              </ul>
            </div>

            <Card className={`gap-0 rounded-2xl border-0 py-0 ${float}`} aria-label="Example of a memory waiting for review">
              <CardContent className="space-y-5 p-7">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Needs your review</p>
                  <Badge variant="secondary" className="rounded-full text-primary">From a caregiver</Badge>
                </div>
                <p className="font-serif text-2xl leading-snug">Your mom&apos;s reading glasses are now kept on the bedside table.</p>
                <p className="rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
                  Would replace: <span className="line-through">Reading glasses are usually on the kitchen windowsill</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <span className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground"><Check className="size-4" aria-hidden /> Approve and replace</span>
                  <span className="inline-flex h-9 items-center rounded-full border px-4 text-sm">Deny</span>
                  <span className="inline-flex h-9 items-center rounded-full border px-4 text-sm">Correct</span>
                </div>
                <Separator />
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">Guidance · Difficult news</p>
                  <p className="text-sm">&ldquo;Answer factually and gently from her memories. Keep it short, then offer to call a family member, or talk about how she is feeling.&rdquo;</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Our promise */}
        <section id="promise" className="mx-auto max-w-6xl scroll-mt-8 px-4 py-24 sm:px-6">
          <div className="max-w-2xl space-y-4">
            <Eyebrow>Our promise</Eyebrow>
            <h2 className="font-serif text-5xl leading-tight">Built around <em className="text-primary">trust</em>.</h2>
          </div>
          <ul className="mt-14 grid gap-x-10 gap-y-12 sm:grid-cols-2">
            {promises.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-4">
                <Icon className="mt-1 size-5 shrink-0 text-primary" aria-hidden />
                <div className="space-y-1.5"><h3 className="font-serif text-2xl">{title}</h3><p className="text-muted-foreground">{body}</p></div>
              </li>
            ))}
          </ul>
        </section>

        {/* Closing */}
        <section className="px-4 pb-24 sm:px-6">
          <div
            className="mx-auto flex max-w-6xl flex-col items-center gap-6 rounded-[2rem] px-6 py-20 text-center"
            style={{ background: "radial-gradient(90% 120% at 50% 0%, #f4d3db 0%, #f8e6e8 45%, #fbf3f1 100%)" }}
          >
            <Flower2 className="size-7 text-primary" aria-hidden />
            <h2 className="max-w-2xl font-serif text-5xl leading-tight">A calmer kind of <em className="text-primary">remembering</em>.</h2>
            <p className="max-w-md text-lg text-muted-foreground">For the person you love, and everyone who cares for them.</p>
            <SignInButton>Meet Keepsake</SignInButton>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:px-6">
          <span className="flex items-center gap-2 font-serif text-lg text-foreground"><Flower2 className="size-4 text-primary" aria-hidden /> keepsake</span>
          <span>Gentle by design. Built around trust.</span>
        </div>
      </footer>
    </div>
  );
}
