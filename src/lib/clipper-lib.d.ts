/**
 * Minimal type declarations for the parts of `clipper-lib` (JS port of
 * Angus Johnson's Clipper 6) used by the Ecofonts geometry engine.
 *
 * The package is CommonJS (`module.exports = ClipperLib`), so only the
 * default export exists at runtime — the named exports below are types only.
 */
declare module "clipper-lib" {
    export interface IntPoint {
        X: number;
        Y: number;
    }
    export type Path = IntPoint[];
    export type Paths = Path[];

    export interface ClipperInstance {
        AddPath(path: Path, polyType: number, closed: boolean): boolean;
        AddPaths(paths: Paths, polyType: number, closed: boolean): boolean;
        Execute(
            clipType: number,
            solution: Paths,
            subjFillType?: number,
            clipFillType?: number,
        ): boolean;
    }

    export interface ClipperConstructor {
        new (initOptions?: number): ClipperInstance;
        Orientation(path: Path): boolean;
        Area(path: Path): number;
        CleanPolygons(paths: Paths, distance?: number): Paths;
        ReversePaths(paths: Paths): void;
    }

    export interface ClipperOffsetInstance {
        AddPath(path: Path, joinType: number, endType: number): void;
        AddPaths(paths: Paths, joinType: number, endType: number): void;
        Execute(solution: Paths, delta: number): void;
    }

    export interface ClipperOffsetConstructor {
        new (miterLimit?: number, arcTolerance?: number): ClipperOffsetInstance;
    }

    const ClipperLib: {
        Clipper: ClipperConstructor;
        ClipperOffset: ClipperOffsetConstructor;
        PolyType: { ptSubject: number; ptClip: number };
        ClipType: {
            ctIntersection: number;
            ctUnion: number;
            ctDifference: number;
            ctXor: number;
        };
        PolyFillType: {
            pftEvenOdd: number;
            pftNonZero: number;
            pftPositive: number;
            pftNegative: number;
        };
        JoinType: { jtSquare: number; jtRound: number; jtMiter: number };
        EndType: {
            etOpenSquare: number;
            etOpenRound: number;
            etOpenButt: number;
            etClosedLine: number;
            etClosedPolygon: number;
        };
    };
    export default ClipperLib;
}
