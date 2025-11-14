export default function Card({ title, children, className = "" }) {
  return (
    <div className={`card bg-base-100 shadow ${className}`}>
      <div className="card-body">
        {title && <h2 className="card-title">{title}</h2>}
        <div>{children}</div>
      </div>
    </div>
  );
}
