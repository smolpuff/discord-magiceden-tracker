import Button from "@/components/Button";
import Card from "@/components/Card";

export default function Page() {
  return (
    <main className="prose">
      <h1>Hello 👋</h1>
      <p>Next + React + Tailwind (latest) + daisyUI (latest) is ready.</p>

      <div className="mt-6">
        <Button>Primary Action</Button>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card title="Starter Card">
          This is a starter card component using daisyUI classes.
        </Card>
        <Card title="Another Card">
          You can duplicate this component and customize as needed.
        </Card>
      </div>
    </main>
  );
}
