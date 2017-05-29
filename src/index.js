(function(exports){
'use strict';

// TODO: Replace with shaderlib
function getShader(id){
  var code = document.getElementById( id ).textContent;
  return document.getElementById("sharedShaderCode").innerText + code;
}

function Broadphase(parameters){
    this.position = new THREE.Vector3(0,0,0);
    this.resolution = new THREE.Vector3(64,64,64);
    this.gridZTiling = new THREE.Vector2();
    this.update();
}
Object.assign(Broadphase.prototype, {
    update: function(){
        var gridPotZ = 1;
        while(gridPotZ * gridPotZ < this.resolution.y) gridPotZ *= 2;
        this.gridZTiling.set(gridPotZ,gridPotZ);
    }
});

function World(parameters){
    parameters = parameters || {};
    var params1 = this.params1 = new THREE.Vector4(
        parameters.stiffness !== undefined ? parameters.stiffness : 1700,
        parameters.damping !== undefined ? parameters.damping : 6,
        parameters.radius !== undefined ? parameters.radius : 0.5,
        0 // unused
    );
    var params2 = this.params2 = new THREE.Vector4(
        parameters.fixedTimeStep !== undefined ? parameters.fixedTimeStep : 1/120,
        parameters.friction !== undefined ? parameters.friction : 2,
        parameters.drag !== undefined ? parameters.drag : 0.1,
        0 // unused
    );
    var params3 = this.params3 = new THREE.Vector4();
    this.time = 0;
    this.fixedTime = 0;
    this.broadphase = new Broadphase();
    this.gravity = new THREE.Vector3(0,0,0);
    if(parameters.gravity) this.gravity.copy(parameters.gravity);
    this.boxSize = new THREE.Vector3(1,1,1);
    if(parameters.boxSize) this.boxSize.copy(parameters.boxSize);
    if(parameters.gridPosition) this.broadphase.position.copy(parameters.gridPosition);
    if(parameters.gridResolution) this.broadphase.resolution.copy(parameters.gridResolution);
    this.broadphase.update();
    this.materials = {};
    this.textures = {};
    this.dataTextures = {};
    this.scenes = {};
    this.renderer = parameters.renderer;
    this.bodyCount = 0;
    this.particleCount = 0;
    Object.defineProperties( this, {
        // Size of a cell side, and diameter of a particle
        radius: {
            get: function(){ return params1.z; },
            set: function(s){ params1.z = s; }
        },
        fixedTimeStep: {
            get: function(){ return params2.x; },
            set: function(fixedTimeStep){ params2.x = fixedTimeStep; }
        },
        stiffness: {
            get: function(){ return params1.x; },
            set: function(stiffness){ params1.x = stiffness; },
        },
        damping: {
            get: function(){ return params1.y; },
            set: function(damping){ params1.y = damping; },
        },
        friction: {
            get: function(){ return params2.y; },
            set: function(friction){ params2.y = friction; },
        },
        drag: {
            get: function(){ return params2.z; },
            set: function(drag){ params2.z = drag; },
        },
        maxParticles: {
            get: function(){
                return this.textures.particlePosLocal.width * this.textures.particlePosLocal.height;
            }
        },
        maxBodies: {
            get: function(){
                return this.textures.bodyPosRead.width * this.textures.bodyPosRead.height;
            }
        },
        bodyPositionTexture: {
            get: function(){ return this.textures.bodyPosRead.texture; }
        },
        bodyMassTexture: {
            get: function(){ return this.textures.bodyMass.texture; }
        },
        bodyQuaternionTexture: {
            get: function(){ return this.textures.bodyQuatRead.texture; }
        },
        bodyForceTexture: {
            get: function(){ return this.textures.bodyForce.texture; }
        },
        bodyTextureSize: {
            get: function(){ return this.textures.bodyPosRead.width; }
        },
        particlePositionTexture: {
            get: function(){ return this.textures.particlePosWorld.texture; }
        },
        particleForceTexture: {
            get: function(){ return this.textures.particleForce.texture; }
        },
        particleTextureSize: {
            get: function(){ return this.textures.particlePosWorld.width; }
        },
        gridTexture: {
            get: function(){ return this.textures.grid.texture; }
        },
        defines: {
            get: function(){ return this.getDefines(); }
        },
    });

    this.initTextures(
        parameters.maxBodies || 8,
        parameters.maxParticles || 8
    );

    // Fullscreen render pass helpers
    Object.assign( this.materials, {
        // For rendering a full screen quad
        textured: new THREE.ShaderMaterial({
            uniforms: {
                texture: { value: null },
                res: { value: new THREE.Vector2() },
            },
            vertexShader: getShader( 'vertexShader' ),
            fragmentShader: getShader( 'testFrag' ),
            defines: this.getDefines()
        })
    });
    this.scenes.fullscreen = new THREE.Scene();
    this.fullscreenCamera = new THREE.Camera();
    this.fullscreenCamera.position.z = 1;
    var plane = new THREE.PlaneBufferGeometry( 2, 2 );
    var fullscreenQuad = this.fullscreenQuad = new THREE.Mesh( plane, this.materials.textured );
    this.scenes.fullscreen.add( fullscreenQuad );
}

// Compute upper closest power of 2 for a number
function powerOfTwoCeil(x){
    var result = 1;
    while(result * result < x){
        result *= 2;
    }
    return result;
}

function pixelToId(x,y,sx,sy){
    return x * sx + y;
}
function idToX(id,sx,sy){
    return id % sx;
}
function idToY(id,sx,sy){
    return Math.floor(id / sy);
}
function idToDataIndex(id, w, h){
    var px = idToX(id, w, h);
    var py = idToY(id, w, h);
    var p = 4 * (py * w + px);
    return p;
}

Object.assign( World.prototype, {
    getDefines: function(overrides){
        var boxSize = this.boxSize;
        var particleTextureSize = this.textures.particlePosLocal.height;
        var gridResolution = this.broadphase.resolution;
        var gridZTiling = this.broadphase.gridZTiling;
        var gridTexture = this.textures.grid;
        var numBodies = this.textures.bodyPosRead.width;
        var defines = Object.assign({}, overrides||{}, {
            boxSize: 'vec3(' + boxSize.x + ', ' + boxSize.y + ', ' + boxSize.z + ')',
            resolution: 'vec2( ' + particleTextureSize.toFixed( 1 ) + ', ' + particleTextureSize.toFixed( 1 ) + " )",
            gridResolution: 'vec3( ' + gridResolution.x.toFixed( 1 ) + ', ' + gridResolution.y.toFixed( 1 ) + ', ' + gridResolution.z.toFixed( 1 ) + " )",
            gridZTiling: 'vec2(' + gridZTiling.x + ', ' + gridZTiling.y + ')',
            gridTextureResolution: 'vec2(' + gridTexture.width + ', ' + gridTexture.height + ')',
            bodyTextureResolution: 'vec2( ' + numBodies.toFixed( 1 ) + ', ' + numBodies.toFixed( 1 ) + " )",
        });
        return defines;
    },
    step: function(deltaTime){
        this.internalStep();
        this.time += deltaTime;
    },
    internalStep: function(){
        this.saveRendererState();
        this.flushData();
        this.updateWorldParticlePositions();
        this.updateRelativeParticlePositions();
        this.updateParticleVelocity();
        this.updateGrid();
        this.updateParticleForce();
        this.updateParticleTorque();
        this.updateBodyForce();
        this.updateBodyTorque();
        this.updateBodyVelocity();
        this.updateBodyAngularVelocity();
        this.updateBodyPosition();
        this.updateBodyQuaternion();
        this.restoreRendererState();
        this.fixedTime += this.fixedTimeStep;
    },
    addBody: function(x, y, z, qx, qy, qz, qw, mass, inertiaX, inertiaY, inertiaZ){
        // Position
        var tex = this.dataTextures.bodyPositions;
        tex.needsUpdate = true;
        var data = tex.image.data;
        var w = tex.image.width;
        var h = tex.image.height;
        var p = idToDataIndex(this.bodyCount, w, h);
        data[p + 0] = x;
        data[p + 1] = y;
        data[p + 2] = z;
        data[p + 3] = 1;

        // Quaternion
        data = this.dataTextures.bodyQuaternions.image.data;
        this.dataTextures.bodyQuaternions.needsUpdate = true;
        data[p + 0] = qx;
        data[p + 1] = qy;
        data[p + 2] = qz;
        data[p + 3] = qw;

        // Mass
        data = this.dataTextures.bodyMass.image.data;
        this.dataTextures.bodyMass.needsUpdate = true;
        data[p + 0] = 1/inertiaX;
        data[p + 1] = 1/inertiaY;
        data[p + 2] = 1/inertiaZ;
        data[p + 3] = 1/mass;

        return this.bodyCount++;
    },
    addParticle: function(bodyId, x, y, z){
        // Position
        var tex = this.dataTextures.particleLocalPositions;
        tex.needsUpdate = true;
        var data = tex.image.data;
        var w = tex.image.width;
        var h = tex.image.height;
        var p = idToDataIndex(this.particleCount, w, h);
        data[p + 0] = x;
        data[p + 1] = y;
        data[p + 2] = z;
        data[p + 3] = bodyId;
        //TODO: update point cloud mapping particles -> bodies?
        return this.particleCount++;
    },
    getBodyId: function(particleId){
        var tex = this.dataTextures.particleLocalPositions;
        var data = tex.image.data;
        var w = tex.image.width;
        var h = tex.image.height;
        var p = idToDataIndex(particleId, w, h);
        return this.dataTextures.particleLocalPositions.image.data[p+3];
    },
    initTextures: function(maxBodies, maxParticles){
        var type = ( /(iPad|iPhone|iPod)/g.test( navigator.userAgent ) ) ? THREE.HalfFloatType : THREE.FloatType;
        var bodyTextureSize = powerOfTwoCeil(maxBodies);
        var particleTextureSize = powerOfTwoCeil(maxParticles);

        Object.assign(this.textures, {
            // Body textures
            bodyPosRead: createRenderTarget(bodyTextureSize, bodyTextureSize, type),
            bodyPosWrite: createRenderTarget(bodyTextureSize, bodyTextureSize, type),
            bodyQuatRead: createRenderTarget(bodyTextureSize, bodyTextureSize, type),
            bodyQuatWrite: createRenderTarget(bodyTextureSize, bodyTextureSize, type),
            bodyVelRead: createRenderTarget(bodyTextureSize, bodyTextureSize, type),
            bodyVelWrite: createRenderTarget(bodyTextureSize, bodyTextureSize, type),
            bodyAngularVelRead: createRenderTarget(bodyTextureSize, bodyTextureSize, type),
            bodyAngularVelWrite: createRenderTarget(bodyTextureSize, bodyTextureSize, type),
            bodyForce: createRenderTarget(bodyTextureSize, bodyTextureSize, type),
            bodyTorque: createRenderTarget(bodyTextureSize, bodyTextureSize, type),
            bodyMass: createRenderTarget(bodyTextureSize, bodyTextureSize, type), // (invInertia.xyz, invMass)

            // Particle textures
            particlePosLocal: createRenderTarget(particleTextureSize, particleTextureSize, type),
            particlePosRelative: createRenderTarget(particleTextureSize, particleTextureSize, type),
            particlePosWorld: createRenderTarget(particleTextureSize, particleTextureSize, type),
            particleVel: createRenderTarget(particleTextureSize, particleTextureSize, type),
            particleForce: createRenderTarget(particleTextureSize, particleTextureSize, type),
            particleTorque: createRenderTarget(particleTextureSize, particleTextureSize, type),

            // Broadphase
            grid: createRenderTarget(2*this.broadphase.resolution.x*this.broadphase.gridZTiling.x, 2*this.broadphase.resolution.z*this.broadphase.gridZTiling.y, type),
        });

        Object.assign(this.dataTextures, {
            bodyPositions: new THREE.DataTexture( new Float32Array(4*bodyTextureSize*bodyTextureSize), bodyTextureSize, bodyTextureSize, THREE.RGBAFormat, type ),
            bodyQuaternions: new THREE.DataTexture( new Float32Array(4*bodyTextureSize*bodyTextureSize), bodyTextureSize, bodyTextureSize, THREE.RGBAFormat, type ),
            particleLocalPositions: new THREE.DataTexture( new Float32Array(4*particleTextureSize*particleTextureSize), particleTextureSize, particleTextureSize, THREE.RGBAFormat, type ),
            bodyMass: new THREE.DataTexture( new Float32Array(4*bodyTextureSize*bodyTextureSize), bodyTextureSize, bodyTextureSize, THREE.RGBAFormat, type ),
        });
    },
    // Render data to rendertargets
    flushData: function(){
        if(this.time > 0) return; // Only want to flush initial data
        this.flushDataToRenderTarget(this.textures.bodyPosWrite, this.dataTextures.bodyPositions);
        this.flushDataToRenderTarget(this.textures.bodyPosRead, this.dataTextures.bodyPositions);
        this.flushDataToRenderTarget(this.textures.bodyQuatWrite, this.dataTextures.bodyQuaternions);
        this.flushDataToRenderTarget(this.textures.bodyQuatRead, this.dataTextures.bodyQuaternions);
        this.flushDataToRenderTarget(this.textures.particlePosLocal, this.dataTextures.particleLocalPositions);
        this.flushDataToRenderTarget(this.textures.bodyMass, this.dataTextures.bodyMass);
    },
    flushDataToRenderTarget: function(renderTarget, dataTexture){
        var texturedMaterial = this.materials.textured;
        texturedMaterial.uniforms.texture.value = dataTexture;
        texturedMaterial.uniforms.res.value.set(renderTarget.width,renderTarget.height);
        this.fullscreenQuad.material = texturedMaterial;
        this.renderer.render( this.scenes.fullscreen, this.fullscreenCamera, renderTarget, true );
        texturedMaterial.uniforms.texture.value = null;
        this.fullscreenQuad.material = null;
    },
    updateWorldParticlePositions: function(){
        var mat = this.materials.localParticlePositionToWorld;
        if(!mat){
            mat = this.materials.localParticlePositionToWorld = new THREE.ShaderMaterial({
                uniforms: {
                    localParticlePosTex:  { value: null },
                    bodyPosTex: { value: null },
                    bodyQuatTex: { value: null },
                },
                vertexShader: getShader( 'vertexShader' ),
                fragmentShader: getShader( 'localParticlePositionToWorldFrag' ),
                defines: this.getDefines()
            });
        }

        var renderer = this.renderer;
        renderer.state.buffers.depth.setTest( false );
        renderer.state.buffers.stencil.setTest( false );

        // Local particle positions to world
        this.fullscreenQuad.material = mat;
        mat.uniforms.localParticlePosTex.value = this.textures.particlePosLocal.texture;
        mat.uniforms.bodyPosTex.value = this.textures.bodyPosRead.texture;
        mat.uniforms.bodyQuatTex.value = this.textures.bodyQuatRead.texture;
        renderer.render( this.scenes.fullscreen, this.fullscreenCamera, this.textures.particlePosWorld, false );
        mat.uniforms.localParticlePosTex.value = null;
        mat.uniforms.bodyPosTex.value = null;
        mat.uniforms.bodyQuatTex.value = null;
        this.fullscreenQuad.material = null;
    },

    updateRelativeParticlePositions: function(){
        var mat = this.materials.localParticlePositionToRelative;
        if(!mat){
            mat = this.materials.localParticlePositionToRelative = new THREE.ShaderMaterial({
                uniforms: {
                    localParticlePosTex:  { value: null },
                    bodyPosTex:  { value: null },
                    bodyQuatTex:  { value: null },
                },
                vertexShader: getShader( 'vertexShader' ),
                fragmentShader: getShader( 'localParticlePositionToRelativeFrag' ),
                defines: this.getDefines()
            });
        }

        // Local particle positions to relative
        this.fullscreenQuad.material = mat;
        mat.uniforms.localParticlePosTex.value = this.textures.particlePosLocal.texture;
        mat.uniforms.bodyPosTex.value = this.textures.bodyPosRead.texture;
        mat.uniforms.bodyQuatTex.value = this.textures.bodyQuatRead.texture;
        this.renderer.render( this.scenes.fullscreen, this.fullscreenCamera, this.textures.particlePosRelative, false );
        this.fullscreenQuad.material = null;
        mat.uniforms.localParticlePosTex.value = null;
        mat.uniforms.bodyPosTex.value = null;
        mat.uniforms.bodyQuatTex.value = null;
    },

    updateParticleVelocity: function(){

        // bodyVelocityToParticleVelocity
        var mat = this.materials.updateParticleVelocity;
        if(!mat){
            mat = this.materials.updateParticleVelocity = new THREE.ShaderMaterial({
                uniforms: {
                    relativeParticlePosTex:  { value: null },
                    bodyVelTex:  { value: null },
                    bodyAngularVelTex:  { value: null },
                },
                vertexShader: getShader( 'vertexShader' ),
                fragmentShader: getShader( 'bodyVelocityToParticleVelocityFrag' ),
                defines: this.getDefines()
            });
        }

        // Body velocity to particles in world space
        this.fullscreenQuad.material = mat;
        mat.uniforms.relativeParticlePosTex.value = this.textures.particlePosRelative.texture;
        mat.uniforms.bodyVelTex.value = this.textures.bodyVelRead.texture;
        mat.uniforms.bodyAngularVelTex.value = this.textures.bodyAngularVelRead.texture;
        this.renderer.render( this.scenes.fullscreen, this.fullscreenCamera, this.textures.particleVel, false );
        this.fullscreenQuad.material = null;
        mat.uniforms.relativeParticlePosTex.value = null;
        mat.uniforms.bodyVelTex.value = null;
        mat.uniforms.bodyAngularVelTex.value = null;
    },

    updateGrid: function(){
        var gridTexture = this.textures.grid;
        var mat = this.materials.mapParticle;
        var setGridStencilMaterial = this.materials.setGridStencil;
        if(!mat){
            mat = this.materials.mapParticle = new THREE.ShaderMaterial({
                uniforms: {
                    posTex: { value: null },
                    cellSize: { value: new THREE.Vector3(this.radius*2, this.radius*2, this.radius*2) },
                    gridPos: { value: this.broadphase.position },
                },
                vertexShader: getShader( 'mapParticleToCellVert' ),
                fragmentShader: getShader( 'mapParticleToCellFrag' ),
                defines: this.getDefines()
            });

            this.scenes.mapParticlesToGrid = new THREE.Scene();
            var mapParticleGeometry = new THREE.BufferGeometry();
            var size = this.textures.particlePosLocal.width;
            var positions = new Float32Array( 3 * size * size );
            var particleIndices = new Float32Array( size * size );
            for(var i=0; i<size*size; i++){
                particleIndices[i] = i; // Need to do this because there's no way to get the vertex index in webgl1 shaders...
            }
            mapParticleGeometry.addAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
            mapParticleGeometry.addAttribute( 'particleIndex', new THREE.BufferAttribute( particleIndices, 1 ) );
            this.mapParticleToCellMesh = new THREE.Points( mapParticleGeometry, this.materials.mapParticle );
            this.scenes.mapParticlesToGrid.add( this.mapParticleToCellMesh );

            // Scene for rendering the stencil buffer - one GL_POINT for each grid cell that we render 4 times
            var sceneStencil = this.scenes.stencil = new THREE.Scene();
            var onePointPerTexelGeometry = new THREE.Geometry();
            gridTexture = this.textures.grid;
            for(var i=0; i<gridTexture.width/2; i++){
                for(var j=0; j<gridTexture.height/2; j++){
                    onePointPerTexelGeometry.vertices.push(
                        new THREE.Vector3(
                            2*i/(gridTexture.width/2)-1,
                            2*j/(gridTexture.height/2)-1,
                            0
                        )
                    );
                }
            }
            setGridStencilMaterial = this.materials.setGridStencil = new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, color: 0xffffff });
            this.setGridStencilMesh = new THREE.Points( onePointPerTexelGeometry, setGridStencilMaterial );
            sceneStencil.add( this.setGridStencilMesh );
        }

        // Set up the grid texture for stencil routing.
        // See http://www.gpgpu.org/static/s2007/slides/15-GPGPU-physics.pdf slide 24
        var renderer = this.renderer;
        var buffers = renderer.state.buffers;
        var gl = renderer.context;
        renderer.clearTarget( gridTexture, true, false, true );
        buffers.depth.setTest( false );
        buffers.depth.setMask( false ); // dont draw depth
        buffers.color.setMask( false ); // dont draw color
        buffers.color.setLocked( true );
        buffers.depth.setLocked( true );
        buffers.stencil.setTest( true );
        buffers.stencil.setOp( gl.REPLACE, gl.REPLACE, gl.REPLACE );
        buffers.stencil.setClear( 0 );
        setGridStencilMaterial.color.setRGB(1,1,1);
        var gridSizeX = gridTexture.width;
        var gridSizeY = gridTexture.height;
        for(var i=0;i<2;i++){
            for(var j=0;j<2;j++){
                var x = i, y = j;
                var stencilValue = i + j * 2;
                if(stencilValue === 0){
                    continue; // No need to set 0 stencil value, it's already cleared
                }
                buffers.stencil.setFunc( gl.ALWAYS, stencilValue, 0xffffffff );
                this.setGridStencilMesh.position.set((x+2)/gridSizeX,(y+2)/gridSizeY,0);
                renderer.render( this.scenes.stencil, this.fullscreenCamera, gridTexture, false );
            }
        }
        buffers.color.setLocked( false );
        buffers.color.setMask( true );
        buffers.depth.setLocked( false );
        buffers.depth.setMask( true );

        // Draw particle positions to grid, use stencil routing.
        buffers.stencil.setFunc( gl.EQUAL, 3, 0xffffffff );
        buffers.stencil.setOp( gl.INCR, gl.INCR, gl.INCR ); // Increment stencil value for every rendered fragment
        this.mapParticleToCellMesh.material = mat;
        mat.uniforms.posTex.value = this.textures.particlePosWorld.texture;
        renderer.render( this.scenes.mapParticlesToGrid, this.fullscreenCamera, this.textures.grid, false );
        mat.uniforms.posTex.value = null;
        this.mapParticleToCellMesh.material = null;
        buffers.stencil.setTest( false );
    },

    updateParticleForce: function(){
        var renderer = this.renderer;
        var buffers = renderer.state.buffers;
        var gl = renderer.context;

        // Update force material
        var forceMaterial = this.materials.force;
        if(!forceMaterial){
            forceMaterial = this.materials.force = new THREE.ShaderMaterial({
                uniforms: {
                    cellSize: { value: new THREE.Vector3(this.radius*2,this.radius*2,this.radius*2) },
                    gridPos: { value: this.broadphase.position },
                    posTex:  { value: null },
                    velTex:  { value: null },
                    bodyAngularVelTex:  { value: null },
                    gridTex:  { value: this.textures.grid.texture },
                    gravity: { value: this.gravity },
                    params1: { value: this.params1 },
                    params2: { value: this.params2 },
                    params3: { value: this.params3 },
                },
                vertexShader: getShader( 'vertexShader' ),
                fragmentShader: getShader( 'updateForceFrag' ),
                defines: this.getDefines()
            });
        }

        // Update particle forces / collision reaction
        buffers.depth.setTest( false );
        buffers.stencil.setTest( false );
        this.fullscreenQuad.material = this.materials.force;
        forceMaterial.uniforms.posTex.value = this.textures.particlePosWorld.texture;
        forceMaterial.uniforms.velTex.value = this.textures.particleVel.texture;
        forceMaterial.uniforms.bodyAngularVelTex.value = this.textures.bodyAngularVelRead.texture;
        renderer.render( this.scenes.fullscreen, this.fullscreenCamera, this.textures.particleForce, false );
        forceMaterial.uniforms.posTex.value = null;
        forceMaterial.uniforms.velTex.value = null;
        forceMaterial.uniforms.bodyAngularVelTex.value = null;
        this.fullscreenQuad.material = null;
    },

    // Update particle torques / collision reaction
    updateParticleTorque: function(){
        var renderer = this.renderer;
        var buffers = renderer.state.buffers;
        var gl = renderer.context;

        // Update torque material
        var updateTorqueMaterial = this.materials.updateTorque;
        if(!updateTorqueMaterial){
            updateTorqueMaterial = this.materials.updateTorque = new THREE.ShaderMaterial({
                uniforms: {
                    cellSize: { value: new THREE.Vector3(this.radius*2, this.radius*2, this.radius*2) },
                    gridPos: { value: this.broadphase.position },
                    posTex:  { value: null },
                    velTex:  { value: null },
                    bodyAngularVelTex:  { value: null },
                    gridTex:  { value: null },
                    params1: { value: this.params1 },
                    params2: { value: this.params2 },
                    params3: { value: this.params3 },
                },
                vertexShader: getShader( 'vertexShader' ),
                fragmentShader: getShader( 'updateTorqueFrag' ),
                defines: this.getDefines()
            });
        }

        buffers.depth.setTest( false );
        buffers.stencil.setTest( false );
        this.fullscreenQuad.material = this.materials.updateTorque;
        updateTorqueMaterial.uniforms.gridTex.value = this.textures.grid.texture;
        updateTorqueMaterial.uniforms.posTex.value = this.textures.particlePosWorld.texture;
        updateTorqueMaterial.uniforms.velTex.value = this.textures.particleVel.texture;
        updateTorqueMaterial.uniforms.bodyAngularVelTex.value = this.textures.bodyAngularVelRead.texture; // Angular velocity for indivitual particles and bodies are the same
        renderer.render( this.scenes.fullscreen, this.fullscreenCamera, this.textures.particleTorque, false );
        updateTorqueMaterial.uniforms.posTex.value = null;
        updateTorqueMaterial.uniforms.velTex.value = null;
        updateTorqueMaterial.uniforms.bodyAngularVelTex.value = null; // Angular velocity for indivitual particles and bodies are the same
        updateTorqueMaterial.uniforms.gridTex.value = null;
        this.fullscreenQuad.material = null;
    },

    updateBodyForce: function(){
        var renderer = this.renderer;
        var buffers = renderer.state.buffers;
        var gl = renderer.context;

        // Add force to body material
        var addForceToBodyMaterial = this.materials.addForceToBody;
        if(!addForceToBodyMaterial){
            addForceToBodyMaterial = this.materials.addForceToBody = new THREE.ShaderMaterial({
                uniforms: {
                    relativeParticlePosTex:  { value: null },
                    particleForceTex:  { value: null },
                    globalForce:  { value: this.gravity },
                },
                vertexShader: getShader( 'addParticleForceToBodyVert' ),
                fragmentShader: getShader( 'addParticleForceToBodyFrag' ),
                defines: this.getDefines(),
                blending: THREE.AdditiveBlending,
                transparent: true
            });

            // Scene for mapping the particle force to bodies - one GL_POINT for each particle
            this.scenes.mapParticlesToBodies = new THREE.Scene();
            var mapParticleToBodyGeometry = new THREE.BufferGeometry();
            var numParticles = this.textures.particlePosLocal.width;
            var bodyIndices = new Float32Array( numParticles * numParticles );
            var particleIndices = new Float32Array( numParticles * numParticles );
            for(var i=0; i<numParticles * numParticles; i++){
                var particleId = i;
                particleIndices[i] = particleId;
                bodyIndices[i] = this.getBodyId(particleId);
            }
            mapParticleToBodyGeometry.addAttribute( 'position', new THREE.BufferAttribute( new Float32Array(numParticles*numParticles*3), 3 ) );
            mapParticleToBodyGeometry.addAttribute( 'particleIndex', new THREE.BufferAttribute( particleIndices, 1 ) );
            mapParticleToBodyGeometry.addAttribute( 'bodyIndex', new THREE.BufferAttribute( bodyIndices, 1 ) );
            this.mapParticleToBodyMesh = new THREE.Points( mapParticleToBodyGeometry, addForceToBodyMaterial );
            this.scenes.mapParticlesToBodies.add( this.mapParticleToBodyMesh );
        }

        // Add force to bodies
        buffers.depth.setTest( false );
        buffers.stencil.setTest( false );
        renderer.clearTarget(this.textures.bodyForce, true, true, true ); // clear the color only?
        this.mapParticleToBodyMesh.material = this.materials.addForceToBody;
        addForceToBodyMaterial.uniforms.relativeParticlePosTex.value = this.textures.particlePosRelative.texture;
        addForceToBodyMaterial.uniforms.particleForceTex.value = this.textures.particleForce.texture;
        renderer.render( this.scenes.mapParticlesToBodies, this.fullscreenCamera, this.textures.bodyForce, false );
        addForceToBodyMaterial.uniforms.relativeParticlePosTex.value = null;
        addForceToBodyMaterial.uniforms.particleForceTex.value = null;
        this.mapParticleToBodyMesh.material = null;
    },

    saveRendererState: function(){
        this.oldAutoClear = this.renderer.autoClear;
        this.renderer.autoClear = false;

        this.oldClearColor = this.renderer.getClearColor().getHex();
        this.oldClearAlpha = this.renderer.getClearAlpha();
        this.renderer.setClearColor( 0x000000, 1.0 );
    },

    restoreRendererState: function(){
        this.renderer.autoClear = this.oldAutoClear;
        this.renderer.setRenderTarget( null );
        this.renderer.setClearColor( this.oldClearColor, this.oldClearAlpha );
    },

    updateBodyTorque: function(){
        var renderer = this.renderer;

        // Add torque to body material
        var addTorqueToBodyMaterial = this.materials.addTorqueToBody;
        if(!addTorqueToBodyMaterial){
            addTorqueToBodyMaterial = this.materials.addTorqueToBody = new THREE.ShaderMaterial({
                uniforms: {
                    relativeParticlePosTex: { value: null },
                    particleForceTex: { value: null },
                    particleTorqueTex: { value: null },
                    globalForce:  { value: new THREE.Vector3(0,0,0) },
                },
                vertexShader: getShader( 'addParticleTorqueToBodyVert' ),
                fragmentShader: getShader( 'addParticleForceToBodyFrag' ), // reuse
                defines: this.getDefines(),
                blending: THREE.AdditiveBlending,
                transparent: true
            });
        }

        // Add torque to bodies
        renderer.clearTarget(this.textures.bodyTorque, true, true, true ); // clear the color only?
        this.mapParticleToBodyMesh.material = addTorqueToBodyMaterial;
        addTorqueToBodyMaterial.uniforms.relativeParticlePosTex.value = this.textures.particlePosRelative.texture;
        addTorqueToBodyMaterial.uniforms.particleForceTex.value = this.textures.particleForce.texture;
        addTorqueToBodyMaterial.uniforms.particleTorqueTex.value = this.textures.particleTorque.texture;
        renderer.render( this.scenes.mapParticlesToBodies, this.fullscreenCamera, this.textures.bodyTorque, false );
        addTorqueToBodyMaterial.uniforms.relativeParticlePosTex.value = null;
        addTorqueToBodyMaterial.uniforms.particleForceTex.value = null;
        addTorqueToBodyMaterial.uniforms.particleTorqueTex.value = null;
        this.mapParticleToBodyMesh.material = null;
    },

    getUpdateVelocityMaterial: function(){
        // Update body velocity - should work for both linear and angular
        var updateBodyVelocityMaterial = this.materials.updateBodyVelocity;
        if(!updateBodyVelocityMaterial){
            updateBodyVelocityMaterial = this.materials.updateBodyVelocity = new THREE.ShaderMaterial({
                uniforms: {
                    linearAngular:  { type: 'f', value: 0.0 },
                    bodyQuatTex:  { value: null },
                    bodyForceTex:  { value: null },
                    bodyVelTex:  { value: null },
                    bodyMassTex:  { value: null },
                    params2: { value: this.params2 },
                    maxVelocity: { value: new THREE.Vector3(100,100,100) }
                },
                vertexShader: getShader( 'vertexShader' ),
                fragmentShader: getShader( 'updateBodyVelocityFrag' ),
                defines: this.getDefines()
            });
        }
        return updateBodyVelocityMaterial;
    },

    updateBodyVelocity: function(){
        var renderer = this.renderer;

        var updateBodyVelocityMaterial = this.getUpdateVelocityMaterial();

        // Update body velocity
        this.fullscreenQuad.material = updateBodyVelocityMaterial;
        updateBodyVelocityMaterial.uniforms.bodyMassTex.value = this.textures.bodyMass.texture;
        updateBodyVelocityMaterial.uniforms.linearAngular.value = 0;
        updateBodyVelocityMaterial.uniforms.bodyVelTex.value = this.textures.bodyVelRead.texture;
        updateBodyVelocityMaterial.uniforms.bodyForceTex.value = this.textures.bodyForce.texture;
        renderer.render( this.scenes.fullscreen, this.fullscreenCamera, this.textures.bodyVelWrite, false );
        this.fullscreenQuad.material = null;
        updateBodyVelocityMaterial.uniforms.bodyMassTex.value = null;
        updateBodyVelocityMaterial.uniforms.bodyVelTex.value = null;
        updateBodyVelocityMaterial.uniforms.bodyForceTex.value = null;
        this.swapTextures('bodyVelWrite', 'bodyVelRead');
    },

    updateBodyAngularVelocity: function(){
        var renderer = this.renderer;
        // Update body angular velocity
        var updateBodyVelocityMaterial = this.getUpdateVelocityMaterial();
        this.fullscreenQuad.material = updateBodyVelocityMaterial;
        updateBodyVelocityMaterial.uniforms.bodyQuatTex.value = this.textures.bodyQuatRead.texture;
        updateBodyVelocityMaterial.uniforms.bodyMassTex.value = this.textures.bodyMass.texture;
        updateBodyVelocityMaterial.uniforms.linearAngular.value = 1;
        updateBodyVelocityMaterial.uniforms.bodyVelTex.value = this.textures.bodyAngularVelRead.texture;
        updateBodyVelocityMaterial.uniforms.bodyForceTex.value = this.textures.bodyTorque.texture;
        renderer.render( this.scenes.fullscreen, this.fullscreenCamera, this.textures.bodyAngularVelWrite, false );
        this.fullscreenQuad.material = null;
        updateBodyVelocityMaterial.uniforms.bodyQuatTex.value = null;
        updateBodyVelocityMaterial.uniforms.bodyMassTex.value = null;
        updateBodyVelocityMaterial.uniforms.bodyVelTex.value = null;
        updateBodyVelocityMaterial.uniforms.bodyForceTex.value = null;
        this.swapTextures('bodyAngularVelWrite', 'bodyAngularVelRead');
    },

    updateBodyPosition: function(){
        var renderer = this.renderer;

        // Body position update
        var updateBodyPositionMaterial = this.materials.updateBodyPosition;
        if(!updateBodyPositionMaterial){
            updateBodyPositionMaterial = this.materials.updateBodyPosition = new THREE.ShaderMaterial({
                uniforms: {
                    bodyPosTex:  { value: null },
                    bodyVelTex:  { value: null },
                    params2: { value: this.params2 }
                },
                vertexShader: getShader( 'vertexShader' ),
                fragmentShader: getShader( 'updateBodyPositionFrag' ),
                defines: this.getDefines()
            });
        }

        // Update body positions
        this.fullscreenQuad.material = updateBodyPositionMaterial;
        updateBodyPositionMaterial.uniforms.bodyPosTex.value = this.textures.bodyPosRead.texture;
        updateBodyPositionMaterial.uniforms.bodyVelTex.value = this.textures.bodyVelRead.texture;
        renderer.render( this.scenes.fullscreen, this.fullscreenCamera, this.textures.bodyPosWrite, false );
        updateBodyPositionMaterial.uniforms.bodyPosTex.value = null;
        updateBodyPositionMaterial.uniforms.bodyVelTex.value = null;
        this.fullscreenQuad.material = null;
        this.swapTextures('bodyPosWrite', 'bodyPosRead');
    },

    updateBodyQuaternion: function(){
        var renderer = this.renderer;

        // Update body quaternions
        var updateBodyQuaternionMaterial = this.materials.updateBodyQuaternion;
        if(!updateBodyQuaternionMaterial){
            updateBodyQuaternionMaterial = this.materials.updateBodyQuaternion = new THREE.ShaderMaterial({
                uniforms: {
                    bodyQuatTex: { value: null },
                    bodyAngularVelTex: { value: null },
                    params2: { value: this.params2 }
                },
                vertexShader: getShader( 'vertexShader' ),
                fragmentShader: getShader( 'updateBodyQuaternionFrag' ),
                defines: this.getDefines()
            });
        }

        // Update body quaternions
        this.fullscreenQuad.material = updateBodyQuaternionMaterial;
        updateBodyQuaternionMaterial.uniforms.bodyQuatTex.value = this.textures.bodyQuatRead.texture;
        updateBodyQuaternionMaterial.uniforms.bodyAngularVelTex.value = this.textures.bodyAngularVelRead.texture;
        renderer.render( this.scenes.fullscreen, this.fullscreenCamera, this.textures.bodyQuatWrite, false );
        updateBodyQuaternionMaterial.uniforms.bodyQuatTex.value = null;
        updateBodyQuaternionMaterial.uniforms.bodyAngularVelTex.value = null;
        this.fullscreenQuad.material = null;

        this.swapTextures('bodyQuatWrite', 'bodyQuatRead');
    },

    swapTextures: function(a,b){
        var textures = this.textures;
        if(!textures[a]) throw new Error("missing texture " + a);
        if(!textures[b]) throw new Error("missing texture " + b);
        var tmp = textures[a];
        textures[a] = textures[b];
        textures[b] = tmp;
    },

    setSphereRadius: function(sphereIndex, radius){
        if(sphereIndex !== 0) throw new Error("Multiple spheres not supported yet");
        this.params3.w = radius;
    },

    getSphereRadius: function(sphereIndex){
        if(sphereIndex !== 0) throw new Error("Multiple spheres not supported yet");
        return this.params3.w;
    },

    setSpherePosition: function(sphereIndex, x, y, z){
        if(sphereIndex !== 0) throw new Error("Multiple spheres not supported yet");
        this.params3.x = x;
        this.params3.y = y;
        this.params3.z = z;
    }
});

function createRenderTarget(w,h,type,format){
    return new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: format === undefined ? THREE.RGBAFormat : format,
        type: type
    });
}

Object.assign(exports, {
    Broadphase: Broadphase,
    World: World,
});

}).call(null, this);