export default function Button({ className = "", ...props }) {
  return (
    <button className={`btn btn-primary ${className}`} {...props} />
  );
}
