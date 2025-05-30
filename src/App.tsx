import React, {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  useRef,
  type JSX,
  type ForwardedRef,
  type RefObject
} from "react";
import { pointer, select, type Selection } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";

import {
  Background,
  type BackgroundProps
} from "./components/Background/background";
import {
  ZOOM_CONFIGS,
  SCROLL_NODE_POSITIONS,
  COMPONENT_POSITIONS
} from "./helpers/constants";
import {
  clampValue,
  getUpdatedNodePosition,
  shouldBlockEvent,
  shouldBlockPanEvent
} from "./helpers/utils";

import styles from "./App.module.css";
import { ScrollBar } from "./components/ScrollBar/scrollbar";

export interface ReactInfiniteCanvasProps {
  children: JSX.Element;
  className?: string;
  minZoom?: number;
  maxZoom?: number;
  panOnScroll?: boolean;
  invertScroll?: boolean;
  zoomScale?: number;
  scrollBarConfig?: {
    renderScrollBar?: boolean;
    startingPosition?: {
      x: number;
      y: number;
    };
    offset?: {
      x: number;
      y: number;
    };
    color?: string;
    thickness?: string;
    minSize?: string;
  };
  backgroundConfig?: BackgroundProps;
  customComponents?: Array<{
    component: JSX.Element;
    position?: string;
    offset?: { x: number; y: number };
    overlap?: boolean;
    className?: string;
  }>;
  onCanvasMount?: (functions: ReactInfiniteCanvasHandle) => void;
  onZoom?: (event: Event) => void;
  enableArrowKeyPan?: boolean;
  arrowKeyPanStep?: number;
}

export interface CanvasState {
  canvasNode: Selection<
    SVGSVGElement | HTMLDivElement | null,
    unknown,
    null,
    undefined
  >;
  zoomNode: Selection<
    SVGGElement | HTMLDivElement | null,
    unknown,
    null,
    undefined
  >;
  currentPosition: { k: number; x: number; y: number };
  d3Zoom: ZoomBehavior<SVGSVGElement | HTMLDivElement, unknown>;
}

export type ReactInfiniteCanvasHandle = {
  scrollNodeToCenter: ({
    nodeElement,
    offset,
    scale,
    shouldUpdateMaxScale,
    maxScale,
    transitionDuration
  }: {
    nodeElement?: HTMLElement;
    offset?: { x: number; y: number };
    scale?: number;
    shouldUpdateMaxScale?: boolean;
    maxScale?: number;
    transitionDuration?: number;
  }) => void;
  scrollNodeHandler: ({
    nodeElement,
    offset,
    scale,
    shouldUpdateMaxScale,
    maxScale,
    transitionDuration,
    position
  }: {
    nodeElement?: HTMLElement;
    offset?: { x: number; y: number };
    scale?: number;
    shouldUpdateMaxScale?: boolean;
    maxScale?: number;
    transitionDuration?: number;
    position?: string;
  }) => void;
  scrollContentHorizontallyCenter: ({
    offset,
    transitionDuration
  }: {
    offset?: number;
    transitionDuration?: number;
  }) => void;
  fitContentToView: ({
    duration,
    offset,
    scale,
    maxZoomLimit
  }: {
    duration?: number;
    offset?: { x: number; y: number };
    scale?: number;
    maxZoomLimit?: number;
  }) => void;
  getCanvasState: () => CanvasState;
};

interface ReactInfiniteCanvasRendererProps extends ReactInfiniteCanvasProps {
  children: React.ReactElement<object, string>;
  forwardedRef: ForwardedRef<ReactInfiniteCanvasHandle>;
  contentWrapperRef: RefObject<HTMLDivElement | null>;
}

export const ReactInfiniteCanvas = React.forwardRef<ReactInfiniteCanvasHandle, ReactInfiniteCanvasProps>(
  (props, ref) => {
    const wrapperRef = React.useRef<HTMLDivElement>(null);
    return (
      <ReactInfiniteCanvasRenderer
        {...props}
        forwardedRef={ref}
        contentWrapperRef={wrapperRef}
      >
        <div
          ref={wrapperRef}
          style={{ width: "max-content", height: "max-content" }}
        >
          {props.children}
        </div>
      </ReactInfiniteCanvasRenderer>
    );
  }
);
ReactInfiniteCanvas.displayName = "ReactInfiniteCanvas";

const ReactInfiniteCanvasRenderer = memo(
  ({
    children,
    className = "",
    minZoom = ZOOM_CONFIGS.DEFAULT_MIN_ZOOM,
    maxZoom = ZOOM_CONFIGS.DEFAULT_MAX_ZOOM,
    panOnScroll = true,
    zoomScale = ZOOM_CONFIGS.ZOOM_SCALE,
    invertScroll = false,
    customComponents = [],
    scrollBarConfig = {},
    backgroundConfig = {},
    onCanvasMount = () => { },
    onZoom,
    forwardedRef,
    contentWrapperRef,
    enableArrowKeyPan = false,
    arrowKeyPanStep = 10
  }: ReactInfiniteCanvasRendererProps) => {
    const canvasWrapperRef = useRef<HTMLDivElement>(null);
    const canvasWrapperBounds = useRef<DOMRect | null>(null);
    const canvasRef = useRef<SVGSVGElement | HTMLDivElement | null>(null);
    const zoomContainerRef = useRef<SVGGElement | HTMLDivElement | null>(null);
    const scrollBarRef = useRef<{
      onScrollDeltaChangeHandler: (scrollDelta: {
        deltaX: number;
        deltaY: number;
      }) => void;
      resetScrollPos: () => void;
    }>(null);
    const flowRendererRef = contentWrapperRef;
    const isUserPressed = useRef<boolean | null>(null);

    const [isSafariClient, setIsSafariClient] = useState(false);
    const [timeToWaitClient, setTimeToWaitClient] = useState(300);

    useEffect(() => {
      const navigatorExists = typeof window !== 'undefined' && typeof window.navigator !== 'undefined';
      const safariAgent = navigatorExists && /^((?!chrome|android).)*safari/i.test(window.navigator.userAgent);
      setIsSafariClient(!!safariAgent);
      setTimeToWaitClient(safariAgent ? 600 : 300);
    }, []);

    const d3Zoom = useMemo(() => {
      return zoom<SVGSVGElement | HTMLDivElement, unknown>().scaleExtent([
        minZoom,
        maxZoom
      ]);
    }, [maxZoom, minZoom]);

    // Initialize d3Selection with null. It will be set in useEffect.
    const d3Selection = useRef<Selection<SVGSVGElement | HTMLDivElement, unknown, null, undefined> | null>(null);

    const [zoomTransform, setZoomTransform] = useState({
      translateX: 0,
      translateY: 0,
      scale: 1
    });

    // 1. Define ALL handler functions with useCallback and correct dependencies
    const onScrollDeltaHandler = useCallback((scrollDelta: { deltaX: number; deltaY: number; }) => {
      if (!d3Selection.current) return;
      const currentZoom = d3Selection.current.property("__zoom").k || 1;
      const selection = d3Selection.current;
      if (selection) {
        d3Zoom.translateBy(
          selection as Selection<SVGSVGElement | HTMLDivElement, unknown, null, undefined>,
          -(scrollDelta.deltaX / currentZoom),
          -(scrollDelta.deltaY / currentZoom)
        );
      }
    }, [d3Zoom]); // d3Zoom is stable due to useMemo

    const fitContentToView = useCallback(
      function fitContentHandler({
        duration = 500,
        offset = { x: 0, y: 0 },
        scale,
        maxZoomLimit = ZOOM_CONFIGS.FIT_TO_VIEW_MAX_ZOOM,
        disableVerticalCenter = false
      }: {
        duration?: number;
        offset?: { x: number; y: number };
        scale?: number;
        maxZoomLimit?: number;
        disableVerticalCenter?: boolean;
      }) {
        requestIdleCallback(
          () => {
            if (!flowRendererRef.current || !canvasRef.current || !d3Selection.current) return;
            const canvasNode = select(canvasRef.current);
            const contentBounds = flowRendererRef.current.getBoundingClientRect();
            const currentZoom = d3Selection.current.property("__zoom").k || 1;
            const containerBounds = canvasRef.current?.getBoundingClientRect();
            const { width: containerWidth = 0, height: containerHeight = 0 } = containerBounds || {};
            const scaleDiff = 1 / currentZoom;
            const contentWidth = contentBounds.width * scaleDiff;
            const contentHeight = contentBounds.height * scaleDiff;
            const heightRatio = containerHeight / contentHeight;
            const widthRatio = containerWidth / contentWidth;
            const newScale =
              scale ??
              clampValue({ value: Math.min(maxZoomLimit, Math.min(heightRatio, widthRatio)), min: minZoom, max: maxZoom });
            const newWidth = containerWidth - contentWidth * newScale;
            const newHeight = containerHeight - contentHeight * newScale;
            const canCenterVertically = !disableVerticalCenter && heightRatio > widthRatio;
            const baseTranslateX = newWidth / 2;
            const baseTranslateY = canCenterVertically ? newHeight / 2 : 0;
            const translateX = baseTranslateX + offset.x;
            const translateY = baseTranslateY + offset.y;
            const newTransform = zoomIdentity.translate(translateX, translateY).scale(newScale);
            setZoomTransform({ translateX, translateY, scale: newScale });
            scrollBarRef.current?.resetScrollPos();
            canvasNode.transition().duration(duration).call(d3Zoom.transform as any, newTransform);
          },
          { timeout: timeToWaitClient }
        );
      },
      [minZoom, maxZoom, flowRendererRef, canvasRef, timeToWaitClient, d3Zoom, scrollBarRef] // Added setZoomTransform if it were used directly, but it's via newTransform
    );

    const scrollNodeHandler = useCallback(
      ({
        nodeElement,
        offset = { x: 0, y: 0 },
        scale,
        shouldUpdateMaxScale = true,
        maxScale,
        transitionDuration = 300,
        position = SCROLL_NODE_POSITIONS.TOP_CENTER
      }: {
        nodeElement?: HTMLElement;
        offset?: { x: number; y: number };
        scale?: number;
        shouldUpdateMaxScale?: boolean;
        maxScale?: number;
        transitionDuration?: number;
        position?: string;
      }) => {
        requestIdleCallback(
          () => {
            if (!nodeElement || !canvasRef.current || !d3Selection.current) return;
            const zoomLevel = d3Selection.current.property("__zoom");
            const { k: currentScale, x: currentTranslateX, y: currentTranslateY } = zoomLevel;
            const canvasNode = select(canvasRef.current);
            const getUpdatedScale = () => {
              const getClampedScale = (s: number) => (!maxScale ? s : Math.min(maxScale, s));
              if (!scale) return getClampedScale(currentScale);
              let updatedScale = scale;
              if (shouldUpdateMaxScale) updatedScale = Math.max(scale, currentScale);
              return getClampedScale(updatedScale);
            };
            const updatedScale = getUpdatedScale();
            const svgBounds = canvasRef.current!.getBoundingClientRect();
            const nodeBounds = nodeElement.getBoundingClientRect();
            const { updatedX, updatedY } = getUpdatedNodePosition({
              position, svgBounds, nodeBounds, currentTranslateX, currentTranslateY, currentScale, updatedScale, customOffset: { x: offset.x, y: offset.y }
            });
            const newTransform = zoomIdentity.translate(updatedX, updatedY).scale(updatedScale);
            canvasNode.transition().duration(transitionDuration).call(d3Zoom.transform as any, newTransform);
          },
          { timeout: timeToWaitClient }
        );
      },
      [canvasRef, timeToWaitClient, d3Zoom] // minZoom, maxZoom not directly used but affect maxScale behavior if it's relative
    );

    const scrollContentHorizontallyCenter = useCallback(
      ({
        offset = 0,
        transitionDuration = 300
      }: {
        offset?: number;
        transitionDuration?: number;
      }) => {
        requestIdleCallback(
          () => {
            if (!flowRendererRef.current || !canvasRef.current || !d3Selection.current) return;
            const zoomLevel = d3Selection.current.property("__zoom");
            const { k: scale, y: translateY } = zoomLevel;
            const canvasNode = select(canvasRef.current);
            const svgBounds = canvasRef.current!.getBoundingClientRect();
            const nodeBounds = flowRendererRef.current.getBoundingClientRect();
            const scaleDiff = 1 / scale;
            const nodeBoundsWidth = nodeBounds.width * scaleDiff;
            const updatedX = (svgBounds.width - nodeBoundsWidth * scale) / 2 + offset;
            setZoomTransform(prev => ({ ...prev, translateX: updatedX })); // Use functional update for zoomTransform
            const newTransform = zoomIdentity.translate(updatedX, translateY).scale(scale);
            canvasNode.transition().duration(transitionDuration).call(d3Zoom.transform as any, newTransform);
          },
          { timeout: timeToWaitClient }
        );
      },
      [flowRendererRef, canvasRef, timeToWaitClient, d3Zoom] // zoomTransform was a dep, now using functional update.
    );

    const getCanvasState = useCallback((): CanvasState => {
      if (!d3Selection.current || !canvasRef.current || !zoomContainerRef.current) {
        // Return a default or empty state if refs are not ready
        // This might happen if getCanvasState is called too early.
        return {
          canvasNode: select(null as any), // Or handle this case more gracefully
          zoomNode: select(null as any),
          currentPosition: { k: 0, x: 0, y: 0 },
          d3Zoom
        };
      }
      return {
        canvasNode: select(canvasRef.current as SVGSVGElement | HTMLDivElement | null),
        zoomNode: select(zoomContainerRef.current as SVGGElement | HTMLDivElement | null),
        currentPosition: d3Selection.current.property("__zoom") as { k: number; x: number; y: number },
        d3Zoom
      };
    }, [canvasRef, zoomContainerRef, d3Zoom]);

    const onMouseDown = useCallback(() => {
      const bodyElement = document.body;
      if (bodyElement) {
        const mouseDownEvent = new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window });
        bodyElement.dispatchEvent(mouseDownEvent);
      }
    }, []);

    const getContainerOffset = useCallback(function offsetHandler(isVertical = true) {
      const bounds = canvasWrapperBounds.current;
      return isVertical ? (bounds?.top ?? 0) : (bounds?.left ?? 0);
    }, []);

    // 2. useEffect for D3 setup, event listeners, and onZoom prop handling
    useEffect(() => {
      if (!canvasRef.current || !zoomContainerRef.current) return;

      // Create the D3 selection from canvasRef and apply the zoom behavior.
      const selection = select(canvasRef.current as SVGSVGElement | HTMLDivElement);
      selection.call(d3Zoom); // Apply the zoom behavior to the selection.
      d3Selection.current = selection; // Store the configured selection in the ref.

      const zoomNodeSelection = select(zoomContainerRef.current) as Selection<SVGGElement | HTMLDivElement, unknown, null, undefined>;
      canvasWrapperBounds.current = canvasWrapperRef.current?.getBoundingClientRect() ?? null;

      // Use d3Selection.current directly for attaching listeners, after checking it's not null.
      if (!d3Selection.current) return;

      // The d3Zoom behavior itself handles the main zoom and pan gestures based on events from the element it was .call()ed on.
      // We configure d3Zoom with .filter(), .on("zoom", ...), and .on("end", ...).
      d3Zoom
        .filter((event: any) => {
          // Only set grabbing state for left mouse button down
          if (event.type === "mousedown" && event.button === 0 && !isUserPressed.current) {
            isUserPressed.current = true;
            onMouseDown();
          }
          // Allow pan with left button (if not wheeling), and zoom with ctrlKey or wheel.
          // This needs to allow mousedown for right-click to pass through for context menu.
          if (event.type === "wheel") return true; // Always allow wheel events for our custom handler
          if (event.ctrlKey) return true; // Allow ctrlKey for zoom regardless of button

          // For mousedown events, only allow left button to initiate d3-zoom's own pan/drag.
          // Other mousedown events (middle, right) should not be captured by d3-zoom here
          // to allow default browser behavior (like context menu for right-click).
          if (event.type === "mousedown") {
            return event.button === 0; // Only left button mousedown should be handled by d3-zoom drag
          }

          return true; // Allow other events like mousemove, mouseup etc. if they are part of a d3-zoom gesture
        })
        .on("zoom", (event: any) => {
          const nativeTarget = (event.sourceEvent as MouseEvent)?.target as HTMLElement;
          if (nativeTarget && shouldBlockPanEvent({ target: nativeTarget })) return;
          if (event.sourceEvent?.ctrlKey === false && event.type === "zoom") {
            canvasWrapperRef.current?.classList.add(styles.panning);
          }
          const transform = event.transform;
          const { x: translateX, y: translateY, k: scaleVal } = transform;
          setZoomTransform({ translateX, translateY, scale: scaleVal });
          if (isSafariClient && zoomContainerRef.current) {
            (zoomContainerRef.current as HTMLElement).style.transform = `translate(${translateX}px, ${translateY}px) scale(${scaleVal})`;
          } else {
            zoomNodeSelection.attr("transform", `translate(${translateX},${translateY}) scale(${scaleVal})`);
          }
          if (onZoom) onZoom(event);
        });

      d3Zoom.on("end", () => {
        isUserPressed.current = false;
        canvasWrapperRef.current?.classList.remove(styles.panning);
      });

      // Override the default wheel event listener for the selection d3Zoom is attached to.
      d3Selection.current.on("wheel.zoom", (event: any) => {
        if (shouldBlockEvent({ ...event, target: event.target as HTMLElement })) {
          return;
        }

        const effectiveDeltaY = invertScroll ? event.deltaY : -event.deltaY;
        const effectiveDeltaX = invertScroll ? event.deltaX : -event.deltaX;
        const zoomScaleFactor = zoomScale * 0.01;

        if (event.ctrlKey) {
          event.preventDefault();
          if (!d3Selection.current) return;
          const currentZoom = d3Selection.current.property("__zoom").k || 1;
          // Use effectiveDeltaY for zoom calculation
          const nextZoom = currentZoom * 2 ** (-effectiveDeltaY * zoomScaleFactor);
          d3Zoom.scaleTo(d3Selection.current as Selection<SVGSVGElement | HTMLDivElement, unknown, null, undefined>, nextZoom, pointer(event));
        } else if (panOnScroll) {
          event.preventDefault();
          if (!d3Selection.current) return;
          // Use effectiveDeltaX and effectiveDeltaY for panning
          const scrollDeltaValue = { deltaX: effectiveDeltaX, deltaY: effectiveDeltaY };
          scrollBarRef.current?.onScrollDeltaChangeHandler(scrollDeltaValue);
          onScrollDeltaHandler(scrollDeltaValue);
        } else {
          event.preventDefault();
          if (!d3Selection.current) return;
          const currentZoom = d3Selection.current.property("__zoom").k || 1;
          // Use effectiveDeltaY for zoom calculation
          const nextZoom = currentZoom * 2 ** (-effectiveDeltaY * zoomScaleFactor);
          d3Zoom.scaleTo(d3Selection.current as Selection<SVGSVGElement | HTMLDivElement, unknown, null, undefined>, nextZoom, pointer(event));
        }
      }, { passive: false, capture: true });

      // Keyboard navigation logic
      const handleKeyDown = (event: KeyboardEvent) => {
        if (!enableArrowKeyPan || !d3Selection.current) return;

        let dx = 0;
        let dy = 0;

        switch (event.key) {
          case "ArrowUp":
          case "k":
            dy = arrowKeyPanStep;
            break;
          case "ArrowDown":
          case "j":
            dy = -arrowKeyPanStep;
            break;
          case "ArrowLeft":
          case "h":
            dx = arrowKeyPanStep;
            break;
          case "ArrowRight":
          case "l":
            dx = -arrowKeyPanStep;
            break;
          default:
            return; // Not an arrow key
        }

        event.preventDefault();
        d3Zoom.translateBy(d3Selection.current as Selection<SVGSVGElement | HTMLDivElement, unknown, null, undefined>, dx, dy);
      };

      if (enableArrowKeyPan) {
        document.addEventListener("keydown", handleKeyDown);
      } else {
        document.removeEventListener("keydown", handleKeyDown);
      }

      // Cleanup function
      return () => {
        if (d3Selection.current) {
          d3Selection.current.on("wheel.zoom", null); // Remove our custom wheel handler from the selection
        }
        // Clear listeners from the d3Zoom behavior instance itself
        // Pass a function that always returns true to effectively remove the filter's effect.
        d3Zoom.on("zoom", null).on("end", null).filter(() => true);
        document.removeEventListener("keydown", handleKeyDown); // Ensure listener is removed on unmount
      };
    }, [d3Zoom, onZoom, isSafariClient, panOnScroll, onMouseDown, onScrollDeltaHandler, invertScroll, zoomScale, enableArrowKeyPan, arrowKeyPanStep]); // Added invertScroll and zoomScale to dependencies

    // 3. useImperativeHandle must come after the functions it uses are defined.
    useImperativeHandle(forwardedRef, () => ({
      scrollNodeToCenter: (args) => scrollNodeHandler({ ...args, position: SCROLL_NODE_POSITIONS.CENTER_CENTER }),
      scrollNodeHandler,
      scrollContentHorizontallyCenter,
      fitContentToView,
      getCanvasState
    }), [scrollNodeHandler, scrollContentHorizontallyCenter, fitContentToView, getCanvasState]);

    // 4. useEffect for onCanvasMount should run after the imperative handle is set.
    useEffect(() => {
      onCanvasMount({
        scrollNodeToCenter: (args) => scrollNodeHandler({ ...args, position: SCROLL_NODE_POSITIONS.CENTER_CENTER }),
        scrollNodeHandler,
        scrollContentHorizontallyCenter,
        fitContentToView,
        getCanvasState
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps 
    }, [onCanvasMount, scrollNodeHandler, scrollContentHorizontallyCenter, fitContentToView, getCanvasState]);

    return (
      <div className={styles.container}>
        <div
          ref={canvasWrapperRef}
          className={`${styles.canvasWrapper} ${className}`}
        >
          {
            isSafariClient ? (
              <div ref={canvasRef as React.RefObject<HTMLDivElement>} className={styles.canvas}>
                <div ref={zoomContainerRef as React.RefObject<HTMLDivElement>}>
                  <div className={styles.contentWrapper}>{children}</div>
                </div>
              </div>
            ) : (
              <svg
                ref={canvasRef as React.RefObject<SVGSVGElement>}
                className={styles.canvas}
                aria-label="Infinite canvas"
                role="application"
              >
                <g ref={zoomContainerRef as React.RefObject<SVGGElement>}>
                  <foreignObject
                    x={ZOOM_CONFIGS.INITIAL_POSITION_X}
                    y={ZOOM_CONFIGS.INITIAL_POSITION_Y}
                    width={ZOOM_CONFIGS.DEFAULT_LAYOUT}
                    height={ZOOM_CONFIGS.DEFAULT_LAYOUT}
                  >
                    {children}
                  </foreignObject>
                </g>
              </svg>
            )
          }
        </div>
        {
          backgroundConfig.disable ? null : (
            <Background
              maxZoom={maxZoom}
              zoomTransform={zoomTransform}
              {...backgroundConfig}
            />
          )
        }
        {
          scrollBarConfig.renderScrollBar && canvasWrapperRef.current && (
            <ScrollBar
              ref={scrollBarRef}
              scale={zoomTransform.scale}
              {...scrollBarConfig}
              verticalOffsetHeight={canvasWrapperRef.current.offsetHeight}
              horizontalOffsetWidth={canvasWrapperRef.current.offsetWidth}
              getContainerOffset={getContainerOffset}
              onScrollDeltaHandler={onScrollDeltaHandler}
            />
          )
        }
        {customComponents.map((config) => {
          const {
            component,
            position = COMPONENT_POSITIONS.BOTTOM_LEFT,
            offset = { x: 0, y: 0 },
            overlap = true,
            className = ""
          } = config;
          const componentKey = `${position}-${offset.x}-${offset.y}-${overlap}`;
          return (
            <CustomComponentWrapper
              key={componentKey}
              component={component}
              position={position}
              offset={offset}
              overlap={overlap}
              zoomState={{ ...zoomTransform, minZoom, maxZoom }}
              className={className}
            />
          );
        })}
      </div>
    );
  }
);

const CustomComponentWrapper = ({
  component,
  position,
  offset,
  overlap,
  zoomState,
  className
}: {
  component: JSX.Element;
  position: string;
  offset: { x: number; y: number };
  overlap: boolean;
  zoomState: {
    translateX: number;
    translateY: number;
    scale: number;
    minZoom: number;
    maxZoom: number;
  };
  className: string;
}) => {
  const positionStyle = useMemo(() => {
    const updatedPos = Object.values(COMPONENT_POSITIONS).includes(position)
      ? position
      : COMPONENT_POSITIONS.BOTTOM_LEFT;

    const [positionY, positionX] = updatedPos.split("-");
    return {
      [positionX]: offset.x,
      [positionY]: offset.y
    };
  }, [position, offset]);

  const updatedComponent = React.cloneElement(component, {
    zoomState
  });

  return (
    <div
      style={{
        position: "absolute",
        ...positionStyle,
        zIndex: overlap ? 20 : 1
      }}
      className={className}
    >
      {updatedComponent}
    </div>
  );
};
