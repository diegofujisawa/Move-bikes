import React, { useState, useEffect, useRef } from 'react';
import { ChevronUpIcon, ChevronDownIcon } from './icons';

// Custom hook to get the previous value of a prop or state.
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

interface CollapsibleSectionProps {
  title: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
  autoOpenOnFirstItem?: boolean;
  highlightOnCount?: boolean;
}

const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  count,
  children,
  defaultOpen = true,
  autoOpenOnFirstItem = false,
  highlightOnCount = false,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const prevCount = usePrevious(count);

  useEffect(() => {
    // If auto-opening is enabled and the count of items goes from 0 to more than 0,
    // force the section open to notify the user.
    if (autoOpenOnFirstItem && prevCount === 0 && count > 0) {
      setIsOpen(true);
    }
  }, [count, prevCount, autoOpenOnFirstItem]);

  const toggleOpen = () => {
    setIsOpen(!isOpen);
  };

  // Add a visual highlight (blue color and pulsing animation if closed)
  // to draw attention to new items.
  const titleClasses = [
    "text-lg",
    "font-bold",
    "transition-colors",
    highlightOnCount && count > 0 ? "text-blue-700" : "text-gray-800",
    highlightOnCount && count > 0 && !isOpen ? "animate-pulse" : "",
  ].join(" ");

  return (
    <div className="mt-8 pt-6 border-t">
      <button
        onClick={toggleOpen}
        className="w-full flex justify-between items-center text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded-md p-1 -m-1"
        aria-expanded={isOpen}
      >
        <h3 className={titleClasses}>{`${title} (${count})`}</h3>
        {isOpen ? <ChevronUpIcon className="w-6 h-6 text-gray-600" /> : <ChevronDownIcon className="w-6 h-6 text-gray-600" />}
      </button>
      <div className={`transition-all duration-300 ease-in-out overflow-hidden ${isOpen ? 'max-h-[1000px] mt-4' : 'max-h-0'}`}>
        {children}
      </div>
    </div>
  );
};

export default CollapsibleSection;